package com.example.libraryjs

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import java.lang.reflect.InvocationTargetException
import java.util.concurrent.Executor
import kotlin.random.Random

data class HotspotInfo(
    val isRunning: Boolean,
    val ssid: String,
    val password: String,
    val summary: String
)

class WifiHotspotManager(private val context: Context) {
    private val lock = Any()
    private var reservation: WifiManager.LocalOnlyHotspotReservation? = null
    private var currentSignature: String? = null
    private var activeSsid: String = ""
    private var activePassword: String = ""
    private var activeSummary: String = "Wi-Fi hotspot is off."
    @Volatile private var lastStatus: String = "Wi-Fi hotspot is off."

    fun sync(
        enabled: Boolean,
        requestedSsid: String,
        requestedPassword: String,
        onStatusChanged: (String) -> Unit,
        onHotspotReady: (HotspotInfo) -> Unit = {}
    ) {
        synchronized(lock) {
            if (!enabled) {
                stopLocked()
                emitStatus("Wi-Fi hotspot is off.", onStatusChanged)
                return
            }

            val ssid = normalizeSsid(requestedSsid)
            val password = normalizePassword(requestedPassword)
            val signature = "$ssid|$password|${Build.VERSION.SDK_INT}"

            if (reservation != null && currentSignature == signature) {
                emitStatus(lastStatus, onStatusChanged)
                return
            }

            stopLocked()
            startLocked(ssid, password, signature, onStatusChanged, onHotspotReady)
        }
    }

    fun stop() {
        synchronized(lock) {
            stopLocked()
            lastStatus = "Wi-Fi hotspot is off."
            activeSummary = lastStatus
            activeSsid = ""
            activePassword = ""
        }
    }

    fun currentInfo(): HotspotInfo = synchronized(lock) {
        HotspotInfo(
            isRunning = reservation != null,
            ssid = activeSsid,
            password = activePassword,
            summary = activeSummary
        )
    }

    fun currentSummary(): String = synchronized(lock) {
        activeSummary
    }

    private fun startLocked(
        requestedSsid: String,
        requestedPassword: String,
        signature: String,
        onStatusChanged: (String) -> Unit,
        onHotspotReady: (HotspotInfo) -> Unit
    ) {
        val wifiManager = context.applicationContext.getSystemService(WifiManager::class.java)
        if (wifiManager == null) {
            emitStatus("Wi-Fi manager unavailable on this device.", onStatusChanged)
            return
        }

        val callback = object : WifiManager.LocalOnlyHotspotCallback() {
            override fun onStarted(reservation: WifiManager.LocalOnlyHotspotReservation) {
                synchronized(lock) {
                    this@WifiHotspotManager.reservation = reservation
                    currentSignature = signature

                    val extracted = readReservationInfo(reservation)
                    val ssid = extracted?.first?.takeIf { it.isNotBlank() } ?: requestedSsid
                    val pass = extracted?.second?.takeIf { it.isNotBlank() } ?: requestedPassword

                    activeSsid = ssid
                    activePassword = pass
                    activeSummary = if (pass.isNotBlank()) {
                        "Hotspot active: $ssid / $pass"
                    } else {
                        "Hotspot active: $ssid"
                    }

                    emitStatus("Hotspot active: $ssid", onStatusChanged)
                    lastStatus = activeSummary
                    onHotspotReady(currentInfo())
                }
            }

            override fun onFailed(reason: Int) {
                synchronized(lock) {
                    reservation = null
                    currentSignature = null
                    activeSsid = ""
                    activePassword = ""
                    activeSummary = "Hotspot failed to start (reason $reason)."
                    emitStatus(activeSummary, onStatusChanged)
                }
            }

            override fun onStopped() {
                synchronized(lock) {
                    reservation = null
                    currentSignature = null
                    activeSsid = ""
                    activePassword = ""
                    activeSummary = "Hotspot stopped."
                    emitStatus(activeSummary, onStatusChanged)
                }
            }
        }

        val started = if (Build.VERSION.SDK_INT >= 36 && tryStartWithRequestedConfiguration(wifiManager, requestedSsid, requestedPassword, callback)) {
            true
        } else {
            wifiManager.startLocalOnlyHotspot(callback, Handler(Looper.getMainLooper()))
            true
        }

        if (started) {
            activeSsid = requestedSsid
            activePassword = requestedPassword
            activeSummary = if (requestedPassword.isNotBlank()) {
                "Starting hotspot with SSID $requestedSsid / $requestedPassword…"
            } else {
                "Starting hotspot with SSID $requestedSsid…"
            }
            emitStatus("Starting hotspot…", onStatusChanged)
        }
    }

    private fun tryStartWithRequestedConfiguration(
        wifiManager: WifiManager,
        requestedSsid: String,
        requestedPassword: String,
        callback: WifiManager.LocalOnlyHotspotCallback
    ): Boolean {
        val config = buildSoftApConfiguration(requestedSsid, requestedPassword) ?: return false
        val configClass = config.javaClass

        return runCatching {
            val method = WifiManager::class.java.getMethod(
                "startLocalOnlyHotspotWithConfiguration",
                configClass,
                Executor::class.java,
                WifiManager.LocalOnlyHotspotCallback::class.java
            )
            method.invoke(wifiManager, config, ContextCompat.getMainExecutor(context), callback)
            true
        }.getOrElse { error ->
            when (error) {
                is NoSuchMethodException,
                is IllegalAccessException,
                is InvocationTargetException,
                is SecurityException,
                is IllegalArgumentException -> false
                else -> false
            }
        }
    }

    private fun buildSoftApConfiguration(requestedSsid: String, requestedPassword: String): Any? {
        return runCatching {
            val configClass = Class.forName("android.net.wifi.SoftApConfiguration")
            val builderClass = Class.forName("android.net.wifi.SoftApConfiguration\$Builder")
            val builder = builderClass.getDeclaredConstructor().newInstance()

            val wifiSsidClass = Class.forName("android.net.wifi.WifiSsid")
            val wifiSsid = wifiSsidClass.getMethod("fromBytes", ByteArray::class.java)
                .invoke(null, requestedSsid.toByteArray(Charsets.UTF_8))
            builderClass.getMethod("setWifiSsid", wifiSsidClass).invoke(builder, wifiSsid)

            val securityField = configClass.getField("SECURITY_TYPE_WPA2_PSK")
            val securityType = securityField.getInt(null)
            val passMethod = builderClass.getMethod(
                "setPassphrase",
                String::class.java,
                Int::class.javaPrimitiveType ?: Int::class.java
            )
            passMethod.invoke(builder, requestedPassword, securityType)

            builderClass.getMethod("build").invoke(builder)
        }.getOrNull()
    }

    private fun readReservationInfo(reservation: WifiManager.LocalOnlyHotspotReservation): Pair<String, String>? {
        return runCatching {
            val getConfig = reservation.javaClass.methods.firstOrNull { it.name == "getSoftApConfiguration" && it.parameterCount == 0 }
                ?: return null
            val config = getConfig.invoke(reservation) ?: return null
            val configClass = config.javaClass

            val ssid = runCatching {
                val wifiSsid = configClass.getMethod("getWifiSsid").invoke(config)
                wifiSsid?.toString()
            }.getOrNull()?.let { unquote(it) }.orEmpty()

            val password = runCatching {
                configClass.getMethod("getPassphrase").invoke(config) as? String
            }.getOrNull().orEmpty()

            ssid to password
        }.getOrNull()
    }

    private fun unquote(value: String): String {
        val trimmed = value.trim()
        return if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
            trimmed.substring(1, trimmed.length - 1)
        } else {
            trimmed
        }
    }

    private fun stopLocked() {
        runCatching { reservation?.close() }
        reservation = null
        currentSignature = null
    }

    private fun emitStatus(text: String, onStatusChanged: (String) -> Unit) {
        lastStatus = text
        onStatusChanged(text)
    }

    private fun normalizeSsid(value: String): String {
        val raw = value.trim()
        if (raw.isBlank()) return "LibraryJS"
        return raw.take(32)
    }

    private fun normalizePassword(value: String): String {
        val raw = value.trim()
        if (raw.length >= 8) return raw.take(63)
        val alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        val generated = buildString(12) {
            repeat(12) { append(alphabet[Random.nextInt(alphabet.length)]) }
        }
        return generated
    }
}
