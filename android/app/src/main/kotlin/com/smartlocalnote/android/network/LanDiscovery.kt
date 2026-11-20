package com.smartlocalnote.android.network

import android.content.Context
import android.net.wifi.WifiManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException

data class DiscoveredHost(
  val name: String,
  val ip: String,
  val port: Int,
  val version: String = "",
)

object LanDiscovery {
  private const val DISCOVERY_PORT = 8766
  private const val DISCOVERY_PAYLOAD = "SLN_DISCOVER_V1"

  suspend fun discoverHosts(
    context: Context? = null,
    timeoutMs: Int = 900,
  ): List<DiscoveredHost> = withContext(Dispatchers.IO) {
    val found = LinkedHashMap<String, DiscoveredHost>()
    val multicastLock = acquireMulticastLock(context)
    var socket: DatagramSocket? = null
    try {
      socket = DatagramSocket().apply {
        broadcast = true
        soTimeout = timeoutMs
      }

      val payload = DISCOVERY_PAYLOAD.toByteArray(Charsets.UTF_8)
      val targets = collectBroadcastAddresses()

      // Send two discovery bursts for Wi-Fi UDP reliability
      for (attempt in 0..1) {
        for (addr in targets) {
          try {
            val packet = DatagramPacket(payload, payload.size, addr, DISCOVERY_PORT)
            socket.send(packet)
          } catch (_: Exception) {
            // Ignore unreachable interface
          }
        }
        if (attempt == 0) {
          try {
            Thread.sleep(90)
          } catch (_: InterruptedException) {
            break
          }
        }
      }

      val buffer = ByteArray(2048)
      val deadline = System.currentTimeMillis() + timeoutMs
      while (System.currentTimeMillis() < deadline) {
        val remaining = (deadline - System.currentTimeMillis()).toInt().coerceAtLeast(100)
        socket.soTimeout = remaining
        val replyPacket = DatagramPacket(buffer, buffer.size)
        try {
          socket.receive(replyPacket)
        } catch (_: SocketTimeoutException) {
          break
        } catch (_: Exception) {
          break
        }

        val text = String(replyPacket.data, replyPacket.offset, replyPacket.length, Charsets.UTF_8).trim()
        if (!text.startsWith("{")) continue
        try {
          val json = JSONObject(text)
          val service = json.optString("service", "")
          if (!service.equals("SmartLocalNote", ignoreCase = true)) continue
          val ip = json.optString("ip", "").trim()
            .ifBlank { replyPacket.address?.hostAddress?.trim().orEmpty() }
          val port = json.optInt("port", 8765).takeIf { it in 1..65535 } ?: 8765
          if (ip.isBlank()) continue
          val name = json.optString("name", "").trim().ifBlank { ip }
          val version = json.optString("version", "").trim()
          val key = "$ip:$port"
          found[key] = DiscoveredHost(name = name, ip = ip, port = port, version = version)
        } catch (_: Exception) {
          // Ignore malformed UDP responses
        }
      }
    } catch (_: Exception) {
      // Return whatever was discovered so far
    } finally {
      try {
        socket?.close()
      } catch (_: Exception) {
      }
      try {
        if (multicastLock?.isHeld == true) multicastLock.release()
      } catch (_: Exception) {
      }
    }

    found.values.sortedBy { it.name.lowercase() }
  }

  private fun acquireMulticastLock(context: Context?): WifiManager.MulticastLock? {
    if (context == null) return null
    return try {
      val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
      wifi?.createMulticastLock("sln_lan_discovery")?.apply {
        setReferenceCounted(false)
        acquire()
      }
    } catch (_: Exception) {
      null
    }
  }

  private fun collectBroadcastAddresses(): List<InetAddress> {
    val result = LinkedHashSet<InetAddress>()
    try {
      result.add(InetAddress.getByName("255.255.255.255"))
    } catch (_: Exception) {
    }
    try {
      val interfaces = NetworkInterface.getNetworkInterfaces() ?: return result.toList()
      while (interfaces.hasMoreElements()) {
        val ni = interfaces.nextElement()
        if (!ni.isUp || ni.isLoopback) continue
        for (ifa in ni.interfaceAddresses) {
          val addr = ifa.address
          val broadcast = ifa.broadcast
          if (addr is Inet4Address && broadcast != null) {
            result.add(broadcast)
          }
        }
      }
    } catch (_: Exception) {
    }
    return result.toList()
  }
}
