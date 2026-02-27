# ============================================================
# MINIMAL PATCH - Relay-ready
# Use este patch quando hotspot/NAT ja existem no roteador.
# ============================================================

:local RELAY_PAID_LIST "paid_clients"
:local RELAY_API_PORT 8728
:local VPS_WG_IP "10.200.200.1/32"
:local VPS_PUBLIC_IP ""

# DNS minimo
/ip dns set servers=1.1.1.1,8.8.8.8 allow-remote-requests=yes

# Walled-garden minimo (portal)
:if ([:len [/ip hotspot walled-garden find where comment="relay-wg-core-painel"]] = 0) do={
  /ip hotspot walled-garden add action=allow dst-host="painel.3fconnet.cloud" comment="relay-wg-core-painel"
}
:if ([:len [/ip hotspot walled-garden find where comment="relay-wg-core-root"]] = 0) do={
  /ip hotspot walled-garden add action=allow dst-host="3fconnet.cloud" comment="relay-wg-core-root"
}

# Placeholder list de pagos para casar com Relay
:if ([:len [/ip firewall address-list find where list=$RELAY_PAID_LIST]] = 0) do={
  /ip firewall address-list add list=$RELAY_PAID_LIST address=198.18.255.254 disabled=yes comment="relay-placeholder-paid-list"
}

# API 8728 restrita
:local apiAllowed $VPS_WG_IP
:if ([:len $VPS_PUBLIC_IP] > 0) do={
  :set apiAllowed ($apiAllowed . "," . $VPS_PUBLIC_IP)
}
/ip service set [find where name="api"] disabled=no port=$RELAY_API_PORT address=$apiAllowed

:local allowId [/ip firewall filter find where comment="RELAY API allow WG"]
:if ([:len $allowId] = 0) do={
  /ip firewall filter add chain=input action=accept protocol=tcp dst-port=$RELAY_API_PORT src-address=$VPS_WG_IP comment="RELAY API allow WG"
}

:local dropId [/ip firewall filter find where comment="RELAY API drop others"]
:if ([:len $dropId] = 0) do={
  /ip firewall filter add chain=input action=drop protocol=tcp dst-port=$RELAY_API_PORT comment="RELAY API drop others"
}

:put "[done] Minimal Relay-ready patch aplicado."
