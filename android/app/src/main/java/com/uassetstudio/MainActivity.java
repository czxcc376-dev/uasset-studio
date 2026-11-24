package com.uassetstudio;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * UAsset Studio — 离线 .uasset / .uexp 编辑器外壳。
 *
 * 设计要点：
 *   - 页面从 assets 加载，不联网（Manifest 无 INTERNET 权限）
 *   - 文件读写通过 JS 桥 {@link Bridge} 暴露给页面，避免 WebView 的 file:// 限制
 *   - 支持从文件管理器「用其他应用打开」直接载入 .uasset
 */
public class MainActivity extends AppCompatActivity {

    private WebView web;
    private ValueCallback<Uri[]> pendingFileChooser;
    private static final int REQ_FILE = 1001;
    private static final int REQ_SAVE = 1002;
    private ValueCallback<Uri> pendingSave;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

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
        web.loadUrl("file:///android_asset/index.html");

        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    /** 从外部「打开方式」进来的 .uasset，交给页面处理 */
    private void handleIntent(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        Uri uri = intent.getData();
        String path = uri.toString();
        if (!path.toLowerCase().endsWith(".uasset")) return;
        final String js = "window.__openFromIntent && window.__openFromIntent(" + jsStr(path) + ");";
        web.postDelayed(() -> web.evaluateJavascript(js, null), 600);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_SAVE) {
            String uri = (resultCode == Activity.RESULT_OK && data != null && data.getData() != null)
                    ? data.getData().toString() : "";
            final String js = "window.__onSaveTarget && window.__onSaveTarget(" + jsStr(uri) + ");";
            web.evaluateJavascript(js, null);
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

    private void toast(final String msg) {
        runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
    }

    private static String jsStr(String s) {
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n") + "'";
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

    /** 暴露给页面的文件读写桥（仅本应用可访问） */
    public class Bridge {

        /** 读取 URI 指向的文件，返回 base64（分块读取避免大文件 OOM） */
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

        /** 文件名（用于配对 .uasset / .uexp） */
        @JavascriptInterface
        public String displayName(String uriString) {
            try {
                android.database.Cursor c = getContentResolver().query(
                        Uri.parse(uriString), null, null, null, null);
                if (c != null) {
                    try {
                        if (c.moveToFirst()) {
                            int idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                            if (idx >= 0) return c.getString(idx);
                        }
                    } finally {
                        c.close();
                    }
                }
            } catch (Exception ignored) { }
            String p = Uri.parse(uriString).getLastPathSegment();
            return p == null ? "unknown" : p;
        }

        /** 写入到用户选定的目标 URI */
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

        /**
         * 弹出系统「保存到」对话框。
         * 结果通过 window.__onSaveTargetChosen(uri|null) 回调页面。
         */
        @JavascriptInterface
        public void requestSave(final String suggestedName) {
            runOnUiThread(() -> {
                if (pendingSave != null) {
                    pendingSave.onReceiveValue(null);
                    pendingSave = null;
                }
                pendingSave = uri -> {
                    String arg = uri == null ? "null" : jsStr(uri.toString());
                    web.evaluateJavascript(
                        "window.__onSaveTargetChosen && window.__onSaveTargetChosen(" + arg + ");", null);
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

        @JavascriptInterface
        public String platformInfo() {
            return "{\"platform\":\"android\",\"sdk\":" + Build.VERSION.SDK_INT
                    + ",\"model\":\"" + Build.MODEL.replace("\"", "") + "\"}";
        }

        private String ok(String data) {
            return "{\"ok\":true,\"data\":\"" + data + "\"}";
        }

        private String err(String msg) {
            return "{\"ok\":false,\"error\":\"" + msg.replace("\"", "'").replace("\n", " ") + "\"}";
        }
    }

}
