import { resetRedisMock } from "./test/mocks/ioredis.js";

resetRedisMock();
process.env.REDIS_REQUIRED = process.env.REDIS_REQUIRED || "false";
