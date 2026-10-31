package io.github.shalone86.daily;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Shows the Daily web app full-screen, with no browser bar. Everything the app does lives on the
 * website, so updates to the site show up here without reinstalling.
 */
public class MainActivity extends Activity {
    static final String HOST = "shalone86.github.io";
    static final String HOME = "https://" + HOST + "/Jekyll-LibDoc/";

    private WebView web;
    private boolean pageReady = false;
    private String pendingShare = null;
    private boolean pendingAdd = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost()) && url.getPath() != null && url.getPath().startsWith("/Jekyll-LibDoc")) {
                    return false;
                }
                // Anything else (GitHub token page, links in tasks…) opens in the normal browser.
                startActivity(new Intent(Intent.ACTION_VIEW, url));
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                deliverShare();
            }
        });
        web.addJavascriptInterface(new Bridge(this), "AndroidApp");
        setContentView(web);
        if (savedInstanceState == null) takeShare(getIntent());
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl(HOME);
        }
    }

    /** Something shared to Daily (a link or text) is handed to the page once it has loaded. */
    private void takeShare(Intent intent) {
        if (intent != null && intent.getBooleanExtra("add_task", false)) pendingAdd = true; // the widget's + button
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        try {
            JSONObject j = new JSONObject();
            String title = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            j.put("title", title == null ? "" : title);
            j.put("text", text == null ? "" : text);
            pendingShare = j.toString();
        } catch (org.json.JSONException e) { /* nothing to share */ }
    }

    private void deliverShare() {
        if (!pageReady) return;
        if (pendingAdd) {
            pendingAdd = false;
            web.postDelayed(new Runnable() {
                @Override public void run() { web.evaluateJavascript("window.focusAddTask && focusAddTask()", null); }
            }, 400);
        }
        if (pendingShare == null) return;
        final String js = "window.receiveShare && receiveShare(" + pendingShare + ")";
        pendingShare = null;
        web.postDelayed(new Runnable() {
            @Override public void run() { web.evaluateJavascript(js, null); }
        }, 400);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        takeShare(intent);
        deliverShare();
    }

    /** Lets the page hand text (symptom logs, backups) to Android's share sheet. */
    static class Bridge {
        private final MainActivity a;
        Bridge(MainActivity activity) { a = activity; }

        /** The page's whole list of upcoming reminders, as JSON: [{id, at, title, loud}]. */
        @JavascriptInterface
        public void setReminders(String json) {
            Reminders.replaceAll(a.getApplicationContext(), json);
        }

        /** "ok", "notifications-off" or "exact-off". */
        @JavascriptInterface
        public String reminderStatus() {
            return Reminders.status(a.getApplicationContext());
        }

        /** Android 13+ asks before an app may show notifications; older versions just allow them. */
        @JavascriptInterface
        public void requestNotifications() {
            a.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (Build.VERSION.SDK_INT >= 33
                            && a.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                        a.requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS"}, 1);
                    } else {
                        a.openSettings(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                    }
                }
            });
        }

        @JavascriptInterface
        public void openAlarmSettings() {
            a.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    a.openSettings(Build.VERSION.SDK_INT >= 31 ? Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM : Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                }
            });
        }

        /** Downloads a web page without the browser's cross-site limits; answers by calling window.__pageDone(id, ok, charset, base64). */
        @JavascriptInterface
        public void fetchPage(final String url, final String id) {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    String charset = "";
                    String result;
                    boolean ok = false;
                    try {
                        String next = url;
                        HttpURLConnection c = null;
                        for (int hops = 0; hops < 6; hops++) {
                            if (!next.startsWith("http://") && !next.startsWith("https://")) throw new Exception("Not a web link");
                            c = (HttpURLConnection) new URL(next).openConnection();
                            c.setInstanceFollowRedirects(false);
                            c.setConnectTimeout(15000);
                            c.setReadTimeout(20000);
                            c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36");
                            c.setRequestProperty("Accept", "text/html,application/xhtml+xml");
                            c.setRequestProperty("Accept-Language", "en");
                            int code = c.getResponseCode();
                            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                                next = new URL(new URL(next), c.getHeaderField("Location")).toString();
                                c.disconnect();
                                continue;
                            }
                            if (code != 200) throw new Exception("HTTP " + code);
                            break;
                        }
                        String type = c.getContentType();
                        if (type != null) {
                            int i = type.toLowerCase().indexOf("charset=");
                            if (i >= 0) charset = type.substring(i + 8).replace("\"", "").trim();
                        }
                        InputStream in = c.getInputStream();
                        ByteArrayOutputStream out = new ByteArrayOutputStream();
                        byte[] buf = new byte[16384];
                        int n;
                        while ((n = in.read(buf)) > 0 && out.size() < 3000000) out.write(buf, 0, n);
                        in.close();
                        result = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
                        ok = true;
                    } catch (Exception e) {
                        result = String.valueOf(e.getMessage());
                    }
                    final String js = "window.__pageDone(" + JSONObject.quote(id) + "," + ok + "," + JSONObject.quote(charset) + "," + JSONObject.quote(result) + ")";
                    a.runOnUiThread(new Runnable() {
                        @Override public void run() { a.web.evaluateJavascript(js, null); }
                    });
                }
            }).start();
        }

        /** The open tasks for the home-screen widget, as JSON: [{id, text, sub}]. */
        @JavascriptInterface
        public void setWidgetTasks(String json) {
            TodoWidget.setTasks(a.getApplicationContext(), json);
        }

        /** Tasks ticked on the widget since the page last asked, as JSON ids; they are forgotten once handed over. */
        @JavascriptInterface
        public String takeWidgetDone() {
            return TodoWidget.takeDone(a.getApplicationContext());
        }

        @JavascriptInterface
        public void shareText(final String title, final String text) {
            a.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType("text/plain");
                    send.putExtra(Intent.EXTRA_SUBJECT, title);
                    send.putExtra(Intent.EXTRA_TEXT, text);
                    a.startActivity(Intent.createChooser(send, title));
                }
            });
        }
    }

    void openSettings(String action) {
        Intent i = new Intent(action);
        i.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
        i.setData(Uri.parse("package:" + getPackageName()));
        try {
            startActivity(i);
        } catch (android.content.ActivityNotFoundException e) {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
        }
    }

    @Override
    public void onBackPressed() {
        // The page closes an open dialog or returns to Today first; only then does Back leave the app.
        web.evaluateJavascript("window.handleBack ? String(handleBack()) : 'false'", new android.webkit.ValueCallback<String>() {
            @Override public void onReceiveValue(String value) { if (!"\"true\"".equals(value)) finish(); }
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onPause() {
        web.onPause(); // lets the page save and sync before the app goes to the background
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        if (pageReady) web.evaluateJavascript("window.applyWidgetDone && applyWidgetDone()", null); // tasks ticked on the widget
    }
}
