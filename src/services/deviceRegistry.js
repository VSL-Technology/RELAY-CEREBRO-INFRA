// src/services/deviceRegistry.js
// Bridge para o registry único em src/registry/deviceRegistry.js
import reg from "../registry/deviceRegistry.js";

export function registerOrUpdateDevice(args) {
  return reg.registerOrUpdateHelloDevice(args);
}

export function getDeviceByToken(token) {
  return reg.getDeviceByToken(token);
}
