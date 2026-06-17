package com.example.libraryjs

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED) return

        val store = ServerStore(context.applicationContext)

        if (store.loadAutoStartServersOnAppOpen()) {
            ContextCompat.startForegroundService(
                context.applicationContext,
                Intent(context.applicationContext, ServerService::class.java).setAction(ServerService.ACTION_START)
            )
        }

        if (store.loadAutoOpenOnBoot()) {
            val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
                ?: Intent(context, MainActivity::class.java)
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            runCatching { context.startActivity(launchIntent) }
        }
    }
}
