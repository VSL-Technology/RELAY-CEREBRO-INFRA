const DEFAULT_PAID_LIST_NAME = "paid_clients";
const DEFAULT_BINDING_TYPE = "bypassed";

function safePedidoId(pedidoId) {
  return String(pedidoId || "unknown").replace(/"/g, "").trim();
}

function getPaidListName() {
  const configured = String(process.env.RELAY_PAID_CLIENTS_LIST || "").trim();
  return configured || DEFAULT_PAID_LIST_NAME;
}

function getBindingType() {
  const configured = String(process.env.RELAY_PAID_BINDING_TYPE || "").trim();
  return configured || DEFAULT_BINDING_TYPE;
}

export function getPaidAccessConfig() {
  return {
    paidListName: getPaidListName(),
    bindingType: getBindingType()
  };
}

export function buildAuthorizeCommands({ pedidoId, ip, mac }) {
  const { paidListName, bindingType } = getPaidAccessConfig();
  const comment = `pedido:${safePedidoId(pedidoId)}`;

  return [
    `/ip firewall address-list add list=${paidListName} address=${ip} comment="${comment}"`,
    `/ip hotspot ip-binding add mac-address=${mac} address=${ip} type=${bindingType} comment="${comment}"`,
    `/ip hotspot host remove [find mac-address=${mac}]`,
    `/ip hotspot active remove [find mac-address=${mac}]`
  ];
}

export function buildRevokeCommands({ ip, mac }) {
  const { paidListName } = getPaidAccessConfig();
  const commands = [];

  if (ip) {
    commands.push(`/ip firewall address-list remove [find list=${paidListName} address=${ip}]`);
  }

  if (mac) {
    commands.push(`/ip hotspot ip-binding remove [find mac-address=${mac}]`);
    commands.push(`/ip hotspot active remove [find mac-address=${mac}]`);
    commands.push(`/ip hotspot host remove [find mac-address=${mac}]`);
  }

  return commands;
}

