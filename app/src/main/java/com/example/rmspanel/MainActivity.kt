package com.example.rmspanel

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.*
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.DataOutputStream
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.LaunchedEffect
import com.example.rmspanel.ui.theme.RmsPanelTheme
import kotlinx.coroutines.delay

class MainActivity : ComponentActivity() {

    private var currentUrl: String = ""
    private var kioskModeEnabled: Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Включаем Immersive Mode (скрываем системные панели)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        hideSystemUI()

        // Читаем сохранённые настройки
        val prefs = getSharedPreferences("my_prefs", MODE_PRIVATE)
        val lastUrl = prefs.getString("last_url", "https://crm.brullov.com/app/rms-panel/")
        currentUrl = lastUrl ?: "https://crm.brullov.com/app/rms-panel/"
        kioskModeEnabled = prefs.getBoolean("kiosk_mode", false)

        // Если киоск-режим включён - запускаем его
        if (kioskModeEnabled) {
            startKioskMode()
        }

        setContent {
            RmsPanelTheme {
                KioskScreen(
                    initialUrl = currentUrl,
                    initialKioskMode = kioskModeEnabled,
                    onUrlChange = { newUrl ->
                        currentUrl = newUrl
                        saveUrlToPreferences(newUrl)
                    },
                    onCommandDetected = { param ->
                        handleRmspanel(param)
                    },
                    onKioskModeChange = { enabled ->
                        kioskModeEnabled = enabled
                        saveKioskModeToPreferences(enabled)
                        if (enabled) {
                            startKioskMode()
                        } else {
                            stopKioskMode()
                        }
                    },
                    onExitApp = {
                        stopKioskMode()
                        finish()
                    },
                    onRestoreDefaultLauncher = {
                        clearDefaultLauncher()
                    },
                    isDeviceOwner = isDeviceOwner()
                )
            }
        }
    }

    /**
     * Проверяем, является ли приложение Device Owner
     */
    private fun isDeviceOwner(): Boolean {
        val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        return dpm.isDeviceOwnerApp(packageName)
    }

    /**
     * Запуск киоск-режима
     */
    private fun startKioskMode() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            val adminComponent = ComponentName(this, AdminReceiver::class.java)

            if (dpm.isDeviceOwnerApp(packageName)) {
                // Если Device Owner - добавляем в whitelist
                dpm.setLockTaskPackages(adminComponent, arrayOf(packageName))
            }

            try {
                startLockTask()
            } catch (e: Exception) {
                e.printStackTrace()
                Toast.makeText(this, "Не удалось запустить киоск-режим", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /**
     * Остановка киоск-режима
     */
    private fun stopKioskMode() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            try {
                stopLockTask()
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    /**
     * Скрываем системные кнопки (Immersive Mode)
     */
    private fun hideSystemUI() {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    }

    /**
     * Сохраняем URL
     */
    private fun saveUrlToPreferences(url: String) {
        val prefs = getSharedPreferences("my_prefs", MODE_PRIVATE)
        prefs.edit().putString("last_url", url).apply()
    }

    /**
     * Сохраняем состояние киоск-режима
     */
    private fun saveKioskModeToPreferences(enabled: Boolean) {
        val prefs = getSharedPreferences("my_prefs", MODE_PRIVATE)
        prefs.edit().putBoolean("kiosk_mode", enabled).apply()
    }

    /**
     * handleRmspanel(param): отправляем команду через echo+su
     */
    private fun handleRmspanel(param: String) {
        val command = when (param) {
            "red"   -> "echo w 0x04 > /sys/devices/platform/led_con_h/zigbee_reset"
            "blue"  -> "echo w 0x06 > /sys/devices/platform/led_con_h/zigbee_reset"
            "green" -> "echo w 0x05 > /sys/devices/platform/led_con_h/zigbee_reset"
            "cycle" -> "echo w 0x0b > /sys/devices/platform/led_con_h/zigbee_reset"
            "white" -> "echo w 0x07 > /sys/devices/platform/led_con_h/zigbee_reset"
            else    -> "echo w 0x00 > /sys/devices/platform/led_con_h/zigbee_reset"
        }
        executeSuCommand(command)
    }

    /**
     * Выполняем команду через su (root)
     */
    private fun executeSuCommand(command: String) {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val process = Runtime.getRuntime().exec("su")
                DataOutputStream(process.outputStream).use { os ->
                    os.writeBytes("$command\n")
                    os.writeBytes("exit\n")
                    os.flush()
                }
                process.waitFor()
            } catch (e: Exception) {
                e.printStackTrace()
                runOnUiThread {
                    Toast.makeText(
                        this@MainActivity,
                        "Ошибка при выполнении команды: ${e.message}",
                        Toast.LENGTH_LONG
                    ).show()
                }
            }
        }
    }

    /**
     * Сбрасываем выбор лаунчера (HOME)
     */
    @Suppress("DEPRECATION")
    private fun clearDefaultLauncher() {
        val pm = packageManager
        val intent = Intent(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            addCategory(Intent.CATEGORY_DEFAULT)
        }
        val resolveInfos = pm.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
        for (info in resolveInfos) {
            pm.clearPackagePreferredActivities(info.activityInfo.packageName)
        }

        Toast.makeText(
            this,
            "Сброшен выбор лаунчера. Нажмите «Домой» для выбора.",
            Toast.LENGTH_LONG
        ).show()
    }
}

/**
 * Главное окно (WebView + панель)
 */
@Composable
fun KioskScreen(
    initialUrl: String,
    initialKioskMode: Boolean,
    onUrlChange: (String) -> Unit,
    onCommandDetected: (String) -> Unit,
    onKioskModeChange: (Boolean) -> Unit,
    onExitApp: () -> Unit,
    onRestoreDefaultLauncher: () -> Unit,
    isDeviceOwner: Boolean
) {
    val context = LocalContext.current

    var panelVisible by remember { mutableStateOf(false) }
    var showPasswordDialog by remember { mutableStateOf(false) }
    var passwordInput by remember { mutableStateOf("") }

    val correctPassword = "Asavuf81"

    var webUrl by remember { mutableStateOf(initialUrl) }
    var kioskMode by remember { mutableStateOf(initialKioskMode) }

    val swipeThreshold = 100
    Box(
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(Unit) {
                detectHorizontalDragGestures { _, dragAmount ->
                    if (dragAmount > swipeThreshold) {
                        showPasswordDialog = true
                    }
                }
            }
    ) {
        // WebView
        WebViewScreen(
            modifier = Modifier.fillMaxSize(),
            url = webUrl,
            onCommandDetected = onCommandDetected
        )

        // Диалог пароля
        if (showPasswordDialog) {
            AlertDialog(
                onDismissRequest = { showPasswordDialog = false },
                title = { Text("Введите пароль") },
                text = {
                    Column {
                        Text("Для доступа к панели введите пароль:")
                        Spacer(modifier = Modifier.height(8.dp))
                        OutlinedTextField(
                            value = passwordInput,
                            onValueChange = { passwordInput = it },
                            label = { Text("Пароль") }
                        )
                    }
                },
                confirmButton = {
                    TextButton(
                        onClick = {
                            if (passwordInput == correctPassword) {
                                panelVisible = true
                                showPasswordDialog = false
                                passwordInput = ""
                            } else {
                                Toast.makeText(
                                    context,
                                    "Неверный пароль",
                                    Toast.LENGTH_SHORT
                                ).show()
                            }
                        }
                    ) {
                        Text("OK")
                    }
                },
                dismissButton = {
                    TextButton(
                        onClick = {
                            showPasswordDialog = false
                            passwordInput = ""
                        }
                    ) {
                        Text("Отмена")
                    }
                }
            )
        }

        // Боковая панель
        AnimatedVisibility(
            visible = panelVisible,
            enter = slideInHorizontally(
                initialOffsetX = { it },
                animationSpec = tween(300)
            ),
            exit = slideOutHorizontally(
                targetOffsetX = { it },
                animationSpec = tween(300)
            )
        ) {
            Box(
                modifier = Modifier
                    .fillMaxHeight()
                    .width(320.dp)
                    .background(Color.DarkGray)
                    .padding(16.dp)
            ) {
                Column(
                    verticalArrangement = Arrangement.SpaceBetween,
                    modifier = Modifier.fillMaxSize()
                ) {
                    // Верхняя часть
                    Column {
                        Text(
                            "Настройки",
                            style = MaterialTheme.typography.titleLarge,
                            color = Color.White
                        )
                        Spacer(modifier = Modifier.height(20.dp))

                        // URL настройка
                        Text("URL страницы:", color = Color.White)
                        Spacer(modifier = Modifier.height(4.dp))
                        TextField(
                            value = webUrl,
                            onValueChange = { webUrl = it },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        Button(
                            onClick = { onUrlChange(webUrl) },
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text("Применить URL")
                        }

                        Spacer(modifier = Modifier.height(24.dp))
                        Divider(color = Color.Gray)
                        Spacer(modifier = Modifier.height(16.dp))

                        // Киоск-режим переключатель
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically
                        ) {
                            Column {
                                Text("Киоск-режим", color = Color.White)
                                if (!isDeviceOwner) {
                                    Text(
                                        "Требуется Device Owner",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = Color.Yellow
                                    )
                                }
                            }
                            Switch(
                                checked = kioskMode,
                                onCheckedChange = { enabled ->
                                    kioskMode = enabled
                                    onKioskModeChange(enabled)
                                    if (enabled) {
                                        Toast.makeText(
                                            context,
                                            "Киоск-режим включён",
                                            Toast.LENGTH_SHORT
                                        ).show()
                                    } else {
                                        Toast.makeText(
                                            context,
                                            "Киоск-режим выключен",
                                            Toast.LENGTH_SHORT
                                        ).show()
                                    }
                                }
                            )
                        }

                        if (!isDeviceOwner) {
                            Spacer(modifier = Modifier.height(8.dp))
                            Text(
                                "Для полного киоска выполните:\nadb shell dpm set-device-owner com.example.rmspanel/.AdminReceiver",
                                style = MaterialTheme.typography.bodySmall,
                                color = Color.LightGray
                            )
                        }

                        Spacer(modifier = Modifier.height(16.dp))
                        Divider(color = Color.Gray)
                        Spacer(modifier = Modifier.height(16.dp))

                        // Кнопка лаунчера
                        Button(
                            onClick = { onRestoreDefaultLauncher() },
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text("Вернуть стандартный лаунчер")
                        }
                    }

                    // Нижняя часть
                    Column {
                        Button(
                            onClick = { panelVisible = false },
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = Color.Gray
                            )
                        ) {
                            Text("Скрыть панель")
                        }
                        Spacer(modifier = Modifier.height(8.dp))
                        Button(
                            onClick = { onExitApp() },
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = Color(0xFFB71C1C)
                            )
                        ) {
                            Text("Выйти из приложения")
                        }
                    }
                }
            }
        }
    }
}

/**
 * WebView: при ?rmspanel=red/green/blue/white/cycle -> onCommandDetected(param)
 */
@Composable
fun WebViewScreen(
    modifier: Modifier = Modifier,
    url: String,
    onCommandDetected: (String) -> Unit
) {
    var webViewInstance by remember { mutableStateOf<WebView?>(null) }

    LaunchedEffect(url) {
        while (true) {
            delay(60_000)
            webViewInstance?.reload()
        }
    }

    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )

                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.useWideViewPort = true
                settings.loadWithOverviewMode = true
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW

                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        view: WebView?,
                        request: WebResourceRequest?
                    ): Boolean {
                        val uri = request?.url
                        val param = uri?.getQueryParameter("rmspanel")
                        if (param != null) {
                            onCommandDetected(param)
                            return false
                        }
                        return super.shouldOverrideUrlLoading(view, request)
                    }
                }
                loadUrl(url)
                webViewInstance = this
            }
        },
        update = { webView ->
            webView.loadUrl(url)
        }
    )
}
