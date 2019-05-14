import cluster from "cluster";
import express, { Express } from "express";
import { GraphQLSchema } from "graphql";
import http from "http";
import { Db } from "mongodb";
import { AggregatorRegistry, collectDefaultMetrics } from "prom-client";

import { LanguageCode } from "talk-common/helpers/i18n/locales";
import { createApp, listenAndServe } from "talk-server/app";
import config, { Config } from "talk-server/config";
import getTenantSchema from "talk-server/graph/tenant/schema";
import logger from "talk-server/logger";
import { createQueue, TaskQueue } from "talk-server/queue";
import { I18n } from "talk-server/services/i18n";
import { createJWTSigningConfig } from "talk-server/services/jwt";
import { createMongoDB } from "talk-server/services/mongodb";
import { ensureIndexes } from "talk-server/services/mongodb/indexes";
import {
  AugmentedRedis,
  createAugmentedRedisClient,
  createRedisClient,
} from "talk-server/services/redis";
import TenantCache from "talk-server/services/tenant/cache";
import { basicAuth } from "./app/middleware/basicAuth";
import { noCacheMiddleware } from "./app/middleware/cacheHeaders";
import { JSONErrorHandler } from "./app/middleware/error";
import { accessLogger, errorLogger } from "./app/middleware/logging";
import { notFoundMiddleware } from "./app/middleware/notFound";

export interface ServerOptions {
  /**
   * config when specified will specify the configuration to load.
   */
  config?: Config;
}

export interface ServerStartOptions {
  parent?: Express;
}

/**
 * Server provides an interface to create, start, and manage a Talk Server.
 */
class Server {
  // parentApp is the root application that the server will bind to.
  private parentApp: Express;

  // schema is the GraphQL Schema that relates to the given Tenant.
  private schema: GraphQLSchema;

  // config exposes application specific configuration.
  public config: Config;

  // httpServer is the running instance of the HTTP server that will bind to
  // the requested port.
  public httpServer: http.Server;

  // tasks stores a reference to the queues that can process operations.
  private tasks: TaskQueue;

  // redis stores the redis connection used by the application.
  private redis: AugmentedRedis;

  // mongo stores the mongo connection used by the application.
  private mongo: Db;

  // tenantCache stores the tenant cache used by the application.
  private tenantCache: TenantCache;

  // connected when true, indicates that `connect()` was already called.
  private connected: boolean = false;

  // processing when true, indicates that `process()` was already called.
  private processing: boolean = false;

  // i18n is the server reference to the i18n framework.
  private i18n: I18n;

  constructor(options: ServerOptions) {
    this.parentApp = express();

    // Load the configuration.
    this.config = config
      .load(options.config || {})
      .validate({ allowed: "strict" });
    logger.debug({ config: this.config.toString() }, "loaded configuration");

    // Load the graph schemas.
    this.schema = getTenantSchema();

    // Get the default locale. This is asserted here because the LanguageCode
    // is verified via Convict, but not typed, so this resolves that.
    const defaultLocale = this.config.get("default_locale") as LanguageCode;

    // Setup the translation framework.
    this.i18n = new I18n(defaultLocale);
  }

  /**
   * connect will connect to all the databases and start priming data needed for
   * runtime.
   */
  public async connect() {
    // Guard against double connecting.
    if (this.connected) {
      throw new Error("server has already connected");
    }
    this.connected = true;

    // Load the translations.
    await this.i18n.load();

    // Setup MongoDB.
    this.mongo = await createMongoDB(config);

    // Setup Redis.
    this.redis = await createAugmentedRedisClient(config);

    // Create the TenantCache.
    this.tenantCache = new TenantCache(
      this.mongo,
      createRedisClient(this.config),
      config
    );

    // Prime the tenant cache so it'll be ready to serve now.
    await this.tenantCache.primeAll();

    // Create the Job Queue.
    this.tasks = await createQueue({
      config: this.config,
      mongo: this.mongo,
      tenantCache: this.tenantCache,
      i18n: this.i18n,
    });

    // Setup the metrics collectors.
    collectDefaultMetrics({ timeout: 5000 });
  }

  /**
   * process will start the job processors and ancillary operations.
   */
  public async process() {
    // Guard against double connecting.
    if (this.processing) {
      throw new Error("server has already processing");
    }
    this.processing = true;

    // Create the database indexes if it isn't disabled.
    if (!this.config.get("disable_mongodb_autoindexing")) {
      // Setup the database indexes.
      logger.info("mongodb autoindexing is enabled, starting indexing");
      await ensureIndexes(this.mongo);
    } else {
      logger.info("mongodb autoindexing is disabled, skipping indexing");
    }

    // Launch all of the job processors.
    this.tasks.mailer.process();
    this.tasks.scraper.process();

    // If we are running in concurrency mode, and we are the master, we should
    // setup the aggregator for the cluster metrics.
    if (cluster.isMaster && this.config.get("concurrency") > 1) {
      // Create the aggregator registry for metrics.
      const aggregatorRegistry = new AggregatorRegistry();

      // Setup the cluster metrics server.
      const metricsServer = express();

      // Setup access logger.
      metricsServer.use(accessLogger);

      // Add basic auth if provided.
      const username = this.config.get("metrics_username");
      const password = this.config.get("metrics_password");
      if (username && password) {
        metricsServer.use("/cluster_metrics", basicAuth(username, password));
        logger.info("adding authentication to metrics endpoint");
      } else {
        logger.info(
          "not adding authentication to metrics endpoint, credentials not provided"
        );
      }

      // Cluster metrics will be served on /cluster_metrics.
      metricsServer.get(
        "/cluster_metrics",
        noCacheMiddleware,
        (req, res, next) => {
          aggregatorRegistry.clusterMetrics((err, metrics) => {
            if (err) {
              return next(err);
            }

            res.set("Content-Type", aggregatorRegistry.contentType);
            res.send(metrics);
          });
        }
      );

      // Error handling.
      metricsServer.use(notFoundMiddleware);
      metricsServer.use(errorLogger);
      metricsServer.use(JSONErrorHandler());

      const port = this.config.get("cluster_metrics_port");

      // Star the server listening for cluster metrics.
      await listenAndServe(metricsServer, port);

      logger.info(
        { port, path: "/cluster_metrics" },
        "now listening for cluster metrics"
      );
    }
  }

  /**
   * start orchestrates the application by starting it and returning a promise
   * when the server has started.
   *
   * @param parent the optional express application to bind the server to.
   */
  public async start({ parent }: ServerStartOptions) {
    // Guard against not being connected.
    if (!this.connected) {
      throw new Error("server has not connected yet");
    }

    const port = this.config.get("port");

    // Ensure we have an app to bind to.
    parent = parent ? parent : this.parentApp;

    // Create the signing config.
    const signingConfig = createJWTSigningConfig(this.config);

    // Only enable the metrics server if concurrency is set to 1.
    const metrics = this.config.get("concurrency") === 1;

    // Disables the client routes to serve bundles etc. Useful for devleoping with
    // Webpack Dev Server.
    const disableClientRoutes = this.config.get("disable_client_routes");

    // Create the Talk App, branching off from the parent app.
    const app: Express = await createApp({
      parent,
      mongo: this.mongo,
      redis: this.redis,
      signingConfig,
      tenantCache: this.tenantCache,
      config: this.config,
      schema: this.schema,
      i18n: this.i18n,
      mailerQueue: this.tasks.mailer,
      scraperQueue: this.tasks.scraper,
      metrics,
      disableClientRoutes,
    });

    // Start the application and store the resulting http.Server. The server
    // will return when the server starts listening. The NodeJS application will
    // not exit until all tasks are handled, which for an open socket, is never.
    this.httpServer = await listenAndServe(app, port);

    // TODO: (wyattjoh) add the subscription handler here

    logger.info({ port }, "now listening");
  }
}

export default Server;