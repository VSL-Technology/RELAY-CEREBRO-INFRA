# ============================================================
# MIKROTIK HOTSPOT + PAGAMENTO 3F (Relay-ready)
# Alinhado ao Relay CEREBRO INFRA atual.
# RouterOS v7+
# ============================================================
# O Relay libera cliente pago por:
# - /ip firewall address-list list=paid_clients (ou RELAY_PAID_CLIENTS_LIST)
# - /ip hotspot ip-binding type=bypassed
#
# Este script:
# - ajusta DNS, Hotspot, Walled Garden, NAT
# - prepara API 8728 com restricao de origem (VPS)
# - prepara WireGuard opcional com endpoint DNS
# - evita duplicacao sempre que possivel
# ============================================================

# -----------------------------
# VARIAVEIS (AJUSTE AQUI)
# -----------------------------
:local ROUTER_IDENTITY "LOPESUL-HOTSPOT-XX"

:local LAN_BRIDGE "bridge"
:local LAN_CIDR "192.168.88.1/24"
:local LAN_GATEWAY "192.168.88.1"
:local HOTSPOT_POOL_NAME "hs-pool"
:local HOTSPOT_POOL_RANGE "192.168.88.10-192.168.88.200"
:local HOTSPOT_PROFILE "hs-profile"
:local HOTSPOT_SERVER "hotspot1"
:local HOTSPOT_DNS_NAME "wifi.3fconnet.cloud"

:local WAN_INTERFACE "ether1"

# Deve casar com RELAY_PAID_CLIENTS_LIST no Relay (default: paid_clients)
:local RELAY_PAID_LIST "paid_clients"

:local RELAY_API_USER "relay"
:local RELAY_API_PASS "CHANGE_ME_STRONG_PASSWORD"
:local RELAY_API_PORT 8728

# Origens autorizadas para API do MikroTik
:local VPS_WG_IP "10.200.200.1/32"
# Deixe vazio ("") para desabilitar allow por IP publico
:local VPS_PUBLIC_IP ""

# WireGuard opcional (Relay-ready)
:local WG_ENABLE "yes"
:local WG_IFACE "wg-vps"
:local WG_ENDPOINT "wg.3fconnet.cloud"
:local WG_ENDPOINT_PORT 51820
:local WG_LISTEN_PORT 51822
:local WG_LOCAL_ADDR "10.200.200.10/24"
:local VPS_PUBLIC_KEY "PASTE_VPS_PUBLIC_KEY"

# -----------------------------
# IDENTIDADE
# -----------------------------
/system identity set name=$ROUTER_IDENTITY
:put ("[ok] identity=" . $ROUTER_IDENTITY)

# -----------------------------
# A) DNS
# -----------------------------
/ip dns set servers=1.1.1.1,8.8.8.8 allow-remote-requests=yes
:put "[ok] DNS=1.1.1.1,8.8.8.8 remote-requests=yes"

# -----------------------------
# B) HOTSPOT BASE
# -----------------------------
# Bridge LAN
:local bridgeId [/interface bridge find where name=$LAN_BRIDGE]
:if ([:len $bridgeId] = 0) do={
  :put ("[warn] bridge '" . $LAN_BRIDGE . "' nao existe. Ajuste LAN_BRIDGE ou crie a bridge antes.")
} else={
  :local lanAddrId [/ip address find where interface=$LAN_BRIDGE and address=$LAN_CIDR]
  :if ([:len $lanAddrId] = 0) do={
    /ip address add interface=$LAN_BRIDGE address=$LAN_CIDR comment="relay-hotspot-lan"
    :put ("[add] IP LAN " . $LAN_CIDR . " em " . $LAN_BRIDGE)
  } else={
    :put "[ok] IP LAN ja presente"
  }
}

# Pool hotspot
:local hsPoolId [/ip pool find where name=$HOTSPOT_POOL_NAME]
:if ([:len $hsPoolId] = 0) do={
  /ip pool add name=$HOTSPOT_POOL_NAME ranges=$HOTSPOT_POOL_RANGE comment="relay-hotspot-pool"
  :put ("[add] pool " . $HOTSPOT_POOL_NAME)
} else={
  /ip pool set $hsPoolId ranges=$HOTSPOT_POOL_RANGE
  :put ("[ok] pool " . $HOTSPOT_POOL_NAME . " atualizado")
}

# Profile hotspot
:local hsProfileId [/ip hotspot profile find where name=$HOTSPOT_PROFILE]
:if ([:len $hsProfileId] = 0) do={
  /ip hotspot profile add name=$HOTSPOT_PROFILE hotspot-address=$LAN_GATEWAY dns-name=$HOTSPOT_DNS_NAME login-by=http-chap,http-pap comment="relay-hotspot-profile"
  :put ("[add] hotspot profile " . $HOTSPOT_PROFILE)
} else={
  /ip hotspot profile set $hsProfileId hotspot-address=$LAN_GATEWAY dns-name=$HOTSPOT_DNS_NAME login-by=http-chap,http-pap
  :put ("[ok] hotspot profile " . $HOTSPOT_PROFILE . " atualizado")
}

# Server hotspot
:local hsServerId [/ip hotspot find where name=$HOTSPOT_SERVER]
:if ([:len $hsServerId] = 0) do={
  :if ([:len $bridgeId] = 0) do={
    :put "[warn] hotspot server nao criado porque a bridge LAN nao existe"
  } else={
    /ip hotspot add name=$HOTSPOT_SERVER interface=$LAN_BRIDGE address-pool=$HOTSPOT_POOL_NAME profile=$HOTSPOT_PROFILE disabled=no
    :put ("[add] hotspot server " . $HOTSPOT_SERVER)
  }
} else={
  /ip hotspot set $hsServerId interface=$LAN_BRIDGE address-pool=$HOTSPOT_POOL_NAME profile=$HOTSPOT_PROFILE disabled=no
  :put ("[ok] hotspot server " . $HOTSPOT_SERVER . " atualizado")
}

# -----------------------------
# C) WALLED GARDEN
# -----------------------------
:local ensureWalledGardenHost do={
  :local host $1
  :local tag $2
  :local ruleComment ("relay-wg-" . $tag . "-" . $host)
  :if ([:len [/ip hotspot walled-garden find where comment=$ruleComment]] = 0) do={
    /ip hotspot walled-garden add action=allow dst-host=$host comment=$ruleComment
    :put ("[add] walled-garden host " . $host)
  } else={
    :put ("[ok] walled-garden host " . $host)
  }
}

# Nucleares do portal
$ensureWalledGardenHost "painel.3fconnet.cloud" "core"
$ensureWalledGardenHost "3fconnet.cloud" "core"
$ensureWalledGardenHost "wifi.3fconnet.cloud" "core"
$ensureWalledGardenHost "api.3fconnet.cloud" "core"

# Best-effort wildcard (nao depender apenas dele)
:if ([:len [/ip hotspot walled-garden find where comment="relay-wg-core-*.3fconnet.cloud"]] = 0) do={
  /ip hotspot walled-garden add action=allow dst-host="*.3fconnet.cloud" comment="relay-wg-core-*.3fconnet.cloud"
  :put "[add] wildcard *.3fconnet.cloud (best-effort)"
} else={
  :put "[ok] wildcard *.3fconnet.cloud ja existe"
}

# Pagamento (recomendado; validar com trafego real do checkout)
$ensureWalledGardenHost "api.pagar.me" "payment"
$ensureWalledGardenHost "checkout.pagar.me" "payment"
$ensureWalledGardenHost "assets.pagar.me" "payment"

# Placeholders comuns (descomentear somente se necessario no seu checkout)
# /ip hotspot walled-garden add action=allow dst-host="secure.pagar.me" comment="relay-wg-payment-secure.pagar.me"
# /ip hotspot walled-garden add action=allow dst-host="api.mundipagg.com" comment="relay-wg-payment-api.mundipagg.com"

# -----------------------------
# D) NAT
# -----------------------------
:local natId [/ip firewall nat find where chain="srcnat" and action="masquerade" and out-interface=$WAN_INTERFACE]
:if ([:len $natId] = 0) do={
  /ip firewall nat add chain=srcnat action=masquerade out-interface=$WAN_INTERFACE comment="NAT WAN"
  :put ("[add] NAT WAN em " . $WAN_INTERFACE)
} else={
  :put "[ok] NAT WAN ja existe"
}

# -----------------------------
# E) LISTA DE PAGOS + BYPASS RELAY
# -----------------------------
# Address-list no RouterOS nao tem objeto vazio; cria placeholder desabilitado.
:if ([:len [/ip firewall address-list find where list=$RELAY_PAID_LIST]] = 0) do={
  /ip firewall address-list add list=$RELAY_PAID_LIST address=198.18.255.254 disabled=yes comment="relay-placeholder-paid-list"
  :put ("[add] placeholder da list " . $RELAY_PAID_LIST)
} else={
  :put ("[ok] list " . $RELAY_PAID_LIST . " ja possui entradas")
}

:put "[info] O Relay adiciona/remove ip-binding type=bypassed automaticamente quando cliente paga."
:put "[info] Revise ip-binding antigos (blocked/regular) que possam conflitar com clientes pagos."

# -----------------------------
# F) API 8728 SEGURA
# -----------------------------
:local apiAllowed $VPS_WG_IP
:if ([:len $VPS_PUBLIC_IP] > 0) do={
  :set apiAllowed ($apiAllowed . "," . $VPS_PUBLIC_IP)
}

/ip service set [find where name="api"] disabled=no port=$RELAY_API_PORT address=$apiAllowed
:put ("[ok] API habilitada na porta " . $RELAY_API_PORT . " para " . $apiAllowed)

# Grupo tecnico para Relay (api/read/write)
:local relayGroupId [/user group find where name="relay-api"]
:if ([:len $relayGroupId] = 0) do={
  /user group add name="relay-api" policy=api,read,write,test
  :put "[add] grupo relay-api"
} else={
  /user group set $relayGroupId policy=api,read,write,test
  :put "[ok] grupo relay-api atualizado"
}

# Usuario tecnico do Relay
:local relayUserId [/user find where name=$RELAY_API_USER]
:if ([:len $relayUserId] = 0) do={
  /user add name=$RELAY_API_USER group="relay-api" password=$RELAY_API_PASS disabled=no comment="managed-by-relay"
  :put ("[add] usuario API " . $RELAY_API_USER)
} else={
  /user set $relayUserId group="relay-api" password=$RELAY_API_PASS disabled=no
  :put ("[ok] usuario API " . $RELAY_API_USER . " atualizado")
}

:if ($RELAY_API_PASS = "CHANGE_ME_STRONG_PASSWORD") do={
  :put "[warn] Altere RELAY_API_PASS imediatamente."
}

# Firewall: permitir API so da VPS
:local apiAllowWgId [/ip firewall filter find where comment="RELAY API allow WG"]
:if ([:len $apiAllowWgId] = 0) do={
  /ip firewall filter add chain=input action=accept protocol=tcp dst-port=$RELAY_API_PORT src-address=$VPS_WG_IP comment="RELAY API allow WG"
  :set apiAllowWgId [/ip firewall filter find where comment="RELAY API allow WG"]
  :put "[add] filter allow API via WG"
} else={
  /ip firewall filter set $apiAllowWgId chain=input action=accept protocol=tcp dst-port=$RELAY_API_PORT src-address=$VPS_WG_IP
  :put "[ok] filter allow API via WG atualizado"
}

:if ([:len $VPS_PUBLIC_IP] > 0) do={
  :local apiAllowPubId [/ip firewall filter find where comment="RELAY API allow PUBLIC"]
  :if ([:len $apiAllowPubId] = 0) do={
    /ip firewall filter add chain=input action=accept protocol=tcp dst-port=$RELAY_API_PORT src-address=$VPS_PUBLIC_IP comment="RELAY API allow PUBLIC"
    :set apiAllowPubId [/ip firewall filter find where comment="RELAY API allow PUBLIC"]
    :put "[add] filter allow API via IP publico"
  } else={
    /ip firewall filter set $apiAllowPubId chain=input action=accept protocol=tcp dst-port=$RELAY_API_PORT src-address=$VPS_PUBLIC_IP
    :put "[ok] filter allow API via IP publico atualizado"
  }
}

:local apiDropId [/ip firewall filter find where comment="RELAY API drop others"]
:if ([:len $apiDropId] = 0) do={
  /ip firewall filter add chain=input action=drop protocol=tcp dst-port=$RELAY_API_PORT comment="RELAY API drop others"
  :set apiDropId [/ip firewall filter find where comment="RELAY API drop others"]
  :put "[add] filter drop API restante"
} else={
  /ip firewall filter set $apiDropId chain=input action=drop protocol=tcp dst-port=$RELAY_API_PORT
  :put "[ok] filter drop API restante atualizado"
}

# Garante ordem: allows antes do drop
:do { /ip firewall filter move $apiAllowWgId $apiDropId } on-error={}
:if ([:len $VPS_PUBLIC_IP] > 0) do={
  :local apiAllowPubId2 [/ip firewall filter find where comment="RELAY API allow PUBLIC"]
  :do { /ip firewall filter move $apiAllowPubId2 $apiDropId } on-error={}
}

# -----------------------------
# G) WIREGUARD OPCIONAL (RELAY-READY)
# -----------------------------
:if ($WG_ENABLE = "yes") do={
  :local wgId [/interface wireguard find where name=$WG_IFACE]
  :if ([:len $wgId] = 0) do={
    /interface wireguard add name=$WG_IFACE listen-port=$WG_LISTEN_PORT comment="managed-by-relay"
    :set wgId [/interface wireguard find where name=$WG_IFACE]
    :put ("[add] wireguard interface " . $WG_IFACE)
  } else={
    /interface wireguard set $wgId listen-port=$WG_LISTEN_PORT
    :put ("[ok] wireguard interface " . $WG_IFACE . " atualizada")
  }

  :if ([:len [/ip address find where interface=$WG_IFACE and address=$WG_LOCAL_ADDR]] = 0) do={
    /ip address add interface=$WG_IFACE address=$WG_LOCAL_ADDR comment="relay-wg-local"
    :put ("[add] WG local addr " . $WG_LOCAL_ADDR)
  } else={
    :put "[ok] WG local addr ja existe"
  }

  :if ($VPS_PUBLIC_KEY = "PASTE_VPS_PUBLIC_KEY") do={
    :put "[warn] VPS_PUBLIC_KEY nao definido. Peer WG nao foi criado."
  } else={
    :local peerId [/interface wireguard peers find where interface=$WG_IFACE and public-key=$VPS_PUBLIC_KEY]
    :if ([:len $peerId] = 0) do={
      /interface wireguard peers add interface=$WG_IFACE public-key=$VPS_PUBLIC_KEY endpoint-address=$WG_ENDPOINT endpoint-port=$WG_ENDPOINT_PORT allowed-address=$VPS_WG_IP persistent-keepalive=25 comment="relay-vps-peer"
      :put "[add] peer WG da VPS"
    } else={
      /interface wireguard peers set $peerId endpoint-address=$WG_ENDPOINT endpoint-port=$WG_ENDPOINT_PORT allowed-address=$VPS_WG_IP persistent-keepalive=25
      :put "[ok] peer WG da VPS atualizado"
    }
  }

  :put "[info] WG: local do MikroTik deve ser 10.200.200.X/24 e allowed-address do peer deve ser 10.200.200.1/32"
} else={
  :put "[info] WireGuard desabilitado (WG_ENABLE!=yes)"
}

# -----------------------------
# FIM
# -----------------------------
:put "[done] Padrao Hotspot + Pagamento 3F (Relay-ready) aplicado."
