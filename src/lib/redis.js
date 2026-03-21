import Redis from "ioredis";
import logger from "../services/logger.js";

const REDIS_URL = process.env.REDIS_URL || "";
const redis = REDIS_URL
  ? new Redis(REDIS_URL)
  : new Redis({
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined
    });

redis.on("connect", () => {
  logger.info("redis.connect", {
    url: REDIS_URL || null,
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT || 6379)
  });
});

redis.on("error", (error) => {
  logger.error("redis.error", {
    message: error && error.message ? error.message : String(error)
  });
});

export async function assertRedisReady() {
  try {
    await redis.ping();
    return true;
  } catch (error) {
    logger.error("redis.ping_failed", {
      message: error && error.message ? error.message : String(error)
    });
    return false;
  }
}

export default redis;
