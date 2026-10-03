package com.netzermishaly.jpgtopng;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Hosts the converter (bundled in assets/www) in a WebView. Everything runs
 * on the device: the app has no INTERNET permission, and every request that
 * is not one of the bundled files is answered locally with "404".
 */
public class MainActivity extends Activity {
    private static final String TAG = "JpgToPng";
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/www/index.html";
    private static final String SUBFOLDER = "JPGtoPNG";
    private static final int REQUEST_FILES = 1;
    private static final int REQUEST_FOLDER = 2;
    private static final int REQUEST_STORAGE = 3;

    private WebView webView;
    private ValueCallback<Uri[]> pendingChooser;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        final WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse response = assets.shouldInterceptRequest(request.getUrl());
                if (response != null) return response;
                // Anything else would be a network request: refuse it locally.
                return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                        null, new ByteArrayInputStream(new byte[0]));
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Stay on the bundled page; never navigate anywhere else.
                return !HOST.equals(request.getUrl().getHost());
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                return showFileChooser(callback, params);
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                Log.i(TAG, message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
                return true;
            }
        });

        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");
        webView.loadUrl(START_URL);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    // ---------- File and folder pickers ----------

    private boolean showFileChooser(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        if (pendingChooser != null) pendingChooser.onReceiveValue(null);
        pendingChooser = callback;

        // The page's folder picker is the <input> without an accept list.
        String[] accept = params.getAcceptTypes();
        boolean folder = accept == null || accept.length == 0
                || (accept.length == 1 && (accept[0] == null || accept[0].isEmpty()));

        if (folder) {
            try {
                startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQUEST_FOLDER);
                return true;
            } catch (ActivityNotFoundException e) {
                Log.w(TAG, "No folder picker on this device; falling back to files", e);
            }
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try {
            startActivityForResult(intent, REQUEST_FILES);
            return true;
        } catch (ActivityNotFoundException e) {
            Intent fallback = new Intent(Intent.ACTION_GET_CONTENT);
            fallback.addCategory(Intent.CATEGORY_OPENABLE);
            fallback.setType("image/*");
            fallback.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(fallback, REQUEST_FILES);
                return true;
            } catch (ActivityNotFoundException e2) {
                pendingChooser = null;
                callback.onReceiveValue(null);
                return false;
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_FILES && requestCode != REQUEST_FOLDER) return;
        final ValueCallback<Uri[]> callback = pendingChooser;
        pendingChooser = null;
        if (callback == null) return;
        if (resultCode != RESULT_OK || data == null) {
            callback.onReceiveValue(null);
            return;
        }

        if (requestCode == REQUEST_FILES) {
            List<Uri> uris = new ArrayList<>();
            ClipData clip = data.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            callback.onReceiveValue(uris.toArray(new Uri[0]));
            return;
        }

        // A whole folder: list every file in it (and its subfolders) off the
        // UI thread. The page itself skips anything that is not a photo.
        final Uri tree = data.getData();
        new Thread(() -> {
            List<Uri> files = new ArrayList<>();
            try {
                listTree(tree, DocumentsContract.getTreeDocumentId(tree), files, 0);
            } catch (Exception e) {
                Log.w(TAG, "Listing folder failed", e);
            }
            runOnUiThread(() -> callback.onReceiveValue(files.toArray(new Uri[0])));
        }).start();
    }

    private void listTree(Uri tree, String parentId, List<Uri> out, int depth) {
        if (depth > 16) return;
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        String[] columns = {DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_MIME_TYPE};
        try (Cursor c = getContentResolver().query(children, columns, null, null, null)) {
            if (c == null) return;
            while (c.moveToNext()) {
                String id = c.getString(0);
                String mime = c.getString(1);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    listTree(tree, id, out, depth + 1);
                } else {
                    out.add(DocumentsContract.buildDocumentUriUsingTree(tree, id));
                }
            }
        }
    }

    // ---------- Bridge used by the page to save files ----------

    /** An open file being written by the page. */
    private static final class Sink {
        OutputStream out;
        Uri uri;          // MediaStore entry (Android 10+)
        File file;        // plain file (Android 9 and older)
        String folder;    // e.g. "Pictures/JPGtoPNG"
        String name;
    }

    private final class Bridge {
        private final Map<String, Sink> sinks = new ConcurrentHashMap<>();
        private volatile String lastError = "";

        /** Start a file. Images go to Pictures/JPGtoPNG, anything else to Download/JPGtoPNG. */
        @JavascriptInterface
        public String begin(String name, String mime) {
            try {
                boolean image = mime != null && mime.startsWith("image/");
                String base = image ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS;
                Sink sink = new Sink();
                sink.folder = base + "/" + SUBFOLDER;
                sink.name = name;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH, sink.folder);
                    values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                    Uri collection = image
                            ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                            : MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                    sink.uri = getContentResolver().insert(collection, values);
                    if (sink.uri == null) throw new IOException("MediaStore insert failed");
                    sink.out = getContentResolver().openOutputStream(sink.uri);
                } else {
                    if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                            != PackageManager.PERMISSION_GRANTED) {
                        runOnUiThread(() -> requestPermissions(
                                new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQUEST_STORAGE));
                        lastError = "יש לאשר את הרשאת האחסון ולנסות שוב";
                        return "";
                    }
                    String state = Environment.getExternalStorageState();
                    if (!Environment.MEDIA_MOUNTED.equals(state)) {
                        throw new IOException("Storage is not available (" + state + ")");
                    }
                    File dir = new File(Environment.getExternalStoragePublicDirectory(base), SUBFOLDER);
                    if (!dir.isDirectory() && !dir.mkdirs()) {
                        // The shared folder was refused (e.g. the permission was not applied
                        // yet): save in the app's own folder, which needs no permission.
                        Log.w(TAG, "Cannot create " + dir + "; using the app's own folder");
                        File own = getExternalFilesDir(base);
                        dir = own == null ? null : new File(own, SUBFOLDER);
                        if (dir == null || (!dir.isDirectory() && !dir.mkdirs())) {
                            throw new IOException("Cannot create a folder for saving (storage " + state + ")");
                        }
                        sink.folder = "Android/data/" + getPackageName() + "/files/" + base + "/" + SUBFOLDER;
                    }
                    sink.file = uniqueFile(dir, name);
                    sink.name = sink.file.getName();
                    sink.out = new FileOutputStream(sink.file);
                }
                String id = UUID.randomUUID().toString();
                sinks.put(id, sink);
                return id;
            } catch (Exception e) {
                Log.w(TAG, "begin failed", e);
                lastError = String.valueOf(e.getMessage());
                return "";
            }
        }

        @JavascriptInterface
        public boolean append(String id, String base64) {
            Sink sink = sinks.get(id);
            if (sink == null) {
                lastError = "unknown file";
                return false;
            }
            try {
                sink.out.write(Base64.decode(base64, Base64.DEFAULT));
                return true;
            } catch (Exception e) {
                Log.w(TAG, "append failed", e);
                lastError = String.valueOf(e.getMessage());
                return false;
            }
        }

        /** Finish a file; returns where it was saved (e.g. "Pictures/JPGtoPNG/a.png"). */
        @JavascriptInterface
        public String finish(String id) {
            Sink sink = sinks.remove(id);
            if (sink == null) {
                lastError = "unknown file";
                return "";
            }
            try {
                sink.out.close();
                if (sink.uri != null) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    ContentResolver resolver = getContentResolver();
                    resolver.update(sink.uri, values, null, null);
                    // MediaStore renames duplicates ("a (1).png"); report the real name.
                    try (Cursor c = resolver.query(sink.uri,
                            new String[]{MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
                        if (c != null && c.moveToFirst()) sink.name = c.getString(0);
                    }
                } else {
                    MediaScannerConnection.scanFile(MainActivity.this,
                            new String[]{sink.file.getAbsolutePath()}, null, null);
                }
                return sink.folder + "/" + sink.name;
            } catch (Exception e) {
                Log.w(TAG, "finish failed", e);
                lastError = String.valueOf(e.getMessage());
                discard(sink);
                return "";
            }
        }

        @JavascriptInterface
        public void abort(String id) {
            Sink sink = sinks.remove(id);
            if (sink != null) discard(sink);
        }

        @JavascriptInterface
        public String lastError() {
            return lastError;
        }

        @JavascriptInterface
        public void setKeepScreenOn(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        /** Versions shown in the page's "technical info" section. */
        @JavascriptInterface
        public String info() {
            try {
                JSONObject json = new JSONObject();
                json.put("app", BuildConfig.VERSION_NAME);
                json.put("android", Build.VERSION.RELEASE);
                json.put("sdk", Build.VERSION.SDK_INT);
                json.put("device", Build.MANUFACTURER + " " + Build.MODEL);
                PackageInfo webViewPackage = WebViewCompat.getCurrentWebViewPackage(MainActivity.this);
                json.put("webview", webViewPackage == null ? "?"
                        : webViewPackage.packageName + " " + webViewPackage.versionName);
                return json.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        private void discard(Sink sink) {
            try {
                sink.out.close();
            } catch (Exception ignored) {
                // already closed or never opened
            }
            if (sink.uri != null) {
                getContentResolver().delete(sink.uri, null, null);
            } else if (sink.file != null && !sink.file.delete()) {
                Log.w(TAG, "Could not delete " + sink.file);
            }
        }
    }

    private static File uniqueFile(File dir, String name) {
        File file = new File(dir, name);
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; file.exists(); i++) file = new File(dir, stem + " (" + i + ")" + ext);
        return file;
    }
}
