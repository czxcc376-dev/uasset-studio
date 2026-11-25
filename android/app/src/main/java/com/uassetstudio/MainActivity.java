package com.uassetstudio;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * UAsset Studio — 离线 .uasset / .uexp 编辑器外壳。
 *
 * 三个对外接口：
 *   1. WebView 加载 assets/index.html（离线，无远端依赖）
 *   2. AndroidFS —— 页面读写文件（SAF content:// URI）
 *   3. AndroidMCP —— 页面开关内嵌 MCP 服务；HTTP 请求经 McpHttpServer 转给页面里的
 *      JS 引擎处理（协议与工具都在 JS 里，与 CLI 共用同一套解析代码）
 */
public class MainActivity extends AppCompatActivity {

    private static final int REQ_FILE = 1001;
    private static final int REQ_SAVE = 1002;
    private static final int REQ_PICK_AI = 1003;

    private WebView web;
    private ValueCallback<Uri[]> pendingFileChooser;
    private ValueCallback<Uri> pendingSave;
    private McpHttpServer mcpServer;
    private SharedPreferences prefs;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("uasset_studio", MODE_PRIVATE);

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (pendingFileChooser != null) pendingFileChooser.onReceiveValue(null);
                pendingFileChooser = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(i, "选择 .uasset / .uexp"), REQ_FILE);
                } catch (Exception e) {
                    pendingFileChooser = null;
                    toast("无法打开文件选择器: " + e.getMessage());
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "AndroidFS");
        web.addJavascriptInterface(new McpBridge(), "AndroidMCP");
        web.loadUrl("file:///android_asset/index.html");

        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onDestroy() {
        if (mcpServer != null) {
            mcpServer.stop();
            mcpServer = null;
        }
        super.onDestroy();
    }

    /* ------------------------------------------------------------------ 外部打开 */

    private void handleIntent(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        Uri uri = intent.getData();
        if (!uri.toString().toLowerCase().endsWith(".uasset")) return;
        final String js = "window.__openFromIntent && window.__openFromIntent(" + jsStr(uri.toString()) + ");";
        web.postDelayed(() -> web.evaluateJavascript(js, null), 700);
    }

    /* ------------------------------------------------------------------ 结果回调 */

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_SAVE) {
            Uri target = (resultCode == Activity.RESULT_OK && data != null) ? data.getData() : null;
            if (pendingSave != null) {
                pendingSave.onReceiveValue(target);
                pendingSave = null;
            }
            return;
        }
        if (requestCode == REQ_PICK_AI) {
            if (resultCode == Activity.RESULT_OK && data != null) {
                int added = 0;
                if (data.getClipData() != null) {
                    for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                        if (rememberAiFile(data.getClipData().getItemAt(i).getUri())) added++;
                    }
                } else if (data.getData() != null) {
                    if (rememberAiFile(data.getData())) added++;
                }
                toast(added > 0 ? ("已授权 " + added + " 个文件给 AI") : "未添加文件");
            }
            evalJs("window.__onAiFilesChanged && window.__onAiFilesChanged(" + jsStr(listAiFilesJson()) + ");");
            return;
        }
        if (requestCode != REQ_FILE) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (pendingFileChooser == null) return;
        Uri[] result = null;
        if (resultCode == Activity.RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                result = new Uri[n];
                for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        pendingFileChooser.onReceiveValue(result);
        pendingFileChooser = null;
    }

    /* ------------------------------------------------------------------ 工具 */

    private void toast(final String msg) {
        runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
    }

    private void evalJs(String js) {
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    /**
     * 在 UI 线程执行一段 JS 并同步等结果。
     * 返回值就是 evaluateJavascript 的回调值（对象会被 WebView 序列化成 JSON）。
     */
    private String runJsSync(String script, long timeoutMs) {
        final CountDownLatch latch = new CountDownLatch(1);
        final String[] out = new String[1];
        web.post(() -> {
            try {
                web.evaluateJavascript(script, value -> {
                    out[0] = value;
                    latch.countDown();
                });
            } catch (Exception e) {
                out[0] = null;
                latch.countDown();
            }
        });
        try {
            if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        }
        return out[0];
    }

    private static String jsStr(String s) {
        StringBuilder sb = new StringBuilder("'");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '\'': sb.append("\\'"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\u2028': sb.append("\\u2028"); break;
                case '\u2029': sb.append("\\u2029"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('\'').toString();
    }

    /* ------------------------------------------------------------------ 文件桥 */

    /** 暴露给页面的文件读写桥：AndroidFS.* */
    public class Bridge {

        @JavascriptInterface
        public String readBase64(String uriString) {
            try (InputStream in = getContentResolver().openInputStream(Uri.parse(uriString))) {
                if (in == null) return err("无法打开: " + uriString);
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                return ok(Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
            } catch (Exception e) {
                return err(e.toString());
            }
        }

        @JavascriptInterface
        public String displayName(String uriString) {
            try (android.database.Cursor c = getContentResolver().query(
                    Uri.parse(uriString), null, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (idx >= 0) {
                        String v = c.getString(idx);
                        if (v != null) return v;
                    }
                }
            } catch (Exception ignored) { }
            String p = Uri.parse(uriString).getLastPathSegment();
            return p == null ? "unknown" : p;
        }

        @JavascriptInterface
        public String writeBase64(String uriString, String b64) {
            try (OutputStream out = getContentResolver().openOutputStream(Uri.parse(uriString), "wt")) {
                if (out == null) return err("无法写入: " + uriString);
                out.write(Base64.decode(b64, Base64.NO_WRAP));
                out.flush();
                return ok("written");
            } catch (Exception e) {
                return err(e.toString());
            }
        }

        @JavascriptInterface
        public String platformInfo() {
            return "{\"platform\":\"android\",\"sdk\":" + Build.VERSION.SDK_INT
                    + ",\"model\":\"" + Build.MODEL.replace("\"", "") + "\"}";
        }

        /* ---- AI 可读文件授权（保存在 SharedPreferences，重启后仍有效） ---- */

        @JavascriptInterface
        public String listAiFiles() {
            return listAiFilesJson();
        }

        /** 打开系统选择器，让用户授权文件给 AI 读取 */
        @JavascriptInterface
        public void pickForAi() {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                try {
                    startActivityForResult(i, REQ_PICK_AI);
                } catch (Exception e) {
                    toast("无法打开选择器: " + e.getMessage());
                }
            });
        }

        @JavascriptInterface
        public String forgetAiFile(String uri) {
            try {
                JSONArray old = new JSONArray(prefs.getString("ai_files", "[]"));
                JSONArray next = new JSONArray();
                for (int i = 0; i < old.length(); i++) {
                    JSONObject o = old.getJSONObject(i);
                    if (!uri.equals(o.optString("uri"))) next.put(o);
                }
                prefs.edit().putString("ai_files", next.toString()).apply();
                try {
                    getContentResolver().releasePersistableUriPermission(
                            Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Exception ignored) { }
            } catch (Exception e) {
                return "{\"ok\":false,\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
            }
            return "{\"ok\":true}";
        }

        /** 让用户选一个保存位置，结果回调 window.__onSaveTargetChosen(uri|null) */
        @JavascriptInterface
        public void pickSaveTarget(final String suggestedName) {
            runOnUiThread(() -> {
                if (pendingSave != null) {
                    pendingSave.onReceiveValue(null);
                    pendingSave = null;
                }
                pendingSave = uri -> {
                    String arg = uri == null ? "null" : jsStr(uri.toString());
                    evalJs("window.__onSaveTargetChosen && window.__onSaveTargetChosen(" + arg + ");");
                };
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("application/octet-stream");
                i.putExtra(Intent.EXTRA_TITLE, suggestedName);
                try {
                    startActivityForResult(i, REQ_SAVE);
                } catch (Exception e) {
                    pendingSave.onReceiveValue(null);
                    pendingSave = null;
                    toast("无法打开保存对话框: " + e.getMessage());
                }
            });
        }

        /** 保存专用：直接设置目标（不再弹框），供 uasset_save 用 */
        @JavascriptInterface
        public void requestSave(String suggestedName) {
            pickSaveTarget(suggestedName);
        }

        private String ok(String data) {
            return "{\"ok\":true,\"data\":\"" + data + "\"}";
        }

        private String err(String msg) {
            return "{\"ok\":false,\"error\":" + JSONObject.quote(msg) + "}";
        }
    }

    /* ------------------------------------------------------------------ MCP 桥 */

    /** 暴露给页面的 MCP 控制桥：AndroidMCP.* */
    public class McpBridge {

        @JavascriptInterface
        public String start(int port, boolean allowLan) {
            return startServer(port, allowLan);
        }

        @JavascriptInterface
        public String stop() {
            stopServer();
            return "{\"running\":false}";
        }

        @JavascriptInterface
        public String status() {
            return statusJson();
        }

        @JavascriptInterface
        public String toolsJson() {
            String r = runJsSync(
                    "window.__APP_MCP ? JSON.stringify({tools: window.__APP_MCP.toolNames().map(function(n){return {name:n};})}) : null",
                    5000);
            if (r == null || "null".equals(r)) return "{\"tools\":[]}";
            return r;
        }

        @JavascriptInterface
        public void copy(String text) {
            runOnUiThread(() -> {
                android.content.ClipboardManager cm =
                        (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (cm != null) cm.setPrimaryClip(android.content.ClipData.newPlainText("mcp", text));
                toast("已复制");
            });
        }
    }

    /* ------------------------------------------------------------------ MCP 服务实现 */

    private synchronized String startServer(int port, boolean allowLan) {
        try {
            if (mcpServer != null && mcpServer.isRunning()) {
                mcpServer.stop();
                mcpServer = null;
            }
            if (port < 1024 || port > 65535) {
                return "{\"ok\":false,\"error\":\"端口需在 1024~65535 之间\"}";
            }
            String tools = new McpBridge().toolsJson();
            mcpServer = new McpHttpServer(port, allowLan, this::forwardToWeb, tools);
            mcpServer.start();
            prefs.edit().putInt("mcp_port", port).putBoolean("mcp_lan", allowLan).apply();
            return statusJson();
        } catch (Exception e) {
            mcpServer = null;
            return "{\"ok\":false,\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
        }
    }

    private synchronized void stopServer() {
        if (mcpServer != null) {
            mcpServer.stop();
            mcpServer = null;
        }
    }

    private String statusJson() {
        boolean running = mcpServer != null && mcpServer.isRunning();
        int port = mcpServer != null ? mcpServer.getPort() : prefs.getInt("mcp_port", 8787);
        boolean lan = mcpServer != null && mcpServer.isAllowLan();
        String lanIp = lan ? localIpv4() : null;
        JSONObject o = new JSONObject();
        try {
            o.put("running", running);
            o.put("port", port);
            o.put("lan", lan);
            o.put("endpoint", "http://127.0.0.1:" + port + "/mcp");
            o.put("lanEndpoint", lanIp == null ? JSONObject.NULL : ("http://" + lanIp + ":" + port + "/mcp"));
            o.put("health", "http://127.0.0.1:" + port + "/health");
        } catch (Exception ignored) { }
        return o.toString();
    }

    /** HTTP 请求 → 页面 JS 引擎 → 响应 JSON */
    private String forwardToWeb(String body) {
        String script = "window.__APP_MCP ? window.__APP_MCP.handle(" + jsStr(body) + ") : null";
        String r = runJsSync(script, 25000);
        if (r == null) {
            return "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,"
                    + "\"message\":\"页面无响应（超时或 UI 线程忙）\"}}";
        }
        if ("null".equals(r) || r.isEmpty()) {
            // 通知类消息没有响应体
            return null;
        }
        return r;
    }

    private static String localIpv4() {
        try {
            List<NetworkInterface> ifs = Collections.list(NetworkInterface.getNetworkInterfaces());
            for (NetworkInterface nif : ifs) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (InetAddress addr : Collections.list(nif.getInetAddresses())) {
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) { }
        return null;
    }

    /* ------------------------------------------------------------------ AI 文件授权 */

    private boolean rememberAiFile(Uri uri) {
        try {
            getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) {
            // 某些来源不支持持久授权，仍然记下（当次会话可用）
        }
        try {
            JSONArray arr = new JSONArray(prefs.getString("ai_files", "[]"));
            for (int i = 0; i < arr.length(); i++) {
                if (uri.toString().equals(arr.getJSONObject(i).optString("uri"))) return false;
            }
            JSONObject o = new JSONObject();
            o.put("uri", uri.toString());
            o.put("name", new Bridge().displayName(uri.toString()));
            arr.put(o);
            prefs.edit().putString("ai_files", arr.toString()).apply();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private String listAiFilesJson() {
        JSONArray out = new JSONArray();
        try {
            JSONArray arr = new JSONArray(prefs.getString("ai_files", "[]"));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                JSONObject item = new JSONObject();
                item.put("id", "f" + (i + 1));
                item.put("name", o.optString("name"));
                item.put("uri", o.optString("uri"));
                item.put("isUasset", o.optString("name").toLowerCase().endsWith(".uasset"));
                item.put("isUexp", o.optString("name").toLowerCase().endsWith(".uexp"));
                out.put(item);
            }
        } catch (Exception ignored) { }
        JSONObject root = new JSONObject();
        try {
            root.put("files", out);
            root.put("count", out.length());
            if (out.length() == 0) {
                root.put("hint", "还没有授权文件。在 App 设置 → MCP 服务 → 「添加可读文件」里选。");
            }
        } catch (Exception ignored) { }
        return root.toString();
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript(
                "(function(){try{return !!(window.__onAndroidBack && window.__onAndroidBack());}catch(e){return false;}})()",
                value -> {
                    if (!"true".equals(value)) {
                        MainActivity.super.onBackPressed();
                    }
                });
    }
}
