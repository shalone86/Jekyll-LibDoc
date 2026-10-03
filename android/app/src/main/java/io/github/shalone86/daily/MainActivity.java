package io.github.shalone86.daily;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Shows the Daily web app full-screen, with no browser bar. Everything the app does lives on the
 * website, so updates to the site show up here without reinstalling.
 */
public class MainActivity extends Activity {
    static final String HOST = "shalone86.github.io";
    static final String HOME = "https://" + HOST + "/Jekyll-LibDoc/";

    private WebView web;

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
                // A link to a note opens the Scriptorium notes app if it's installed.
                if (HOST.equals(url.getHost()) && url.getPath() != null && url.getPath().startsWith("/quickstart")) {
                    try {
                        Intent notes = new Intent(Intent.ACTION_VIEW, url);
                        notes.setPackage("io.github.shalone86.scriptorium");
                        startActivity(notes);
                        return true;
                    } catch (android.content.ActivityNotFoundException e) { /* not installed: use the browser */ }
                }
                // Anything else (GitHub token page, links in tasks…) opens in the normal browser.
                startActivity(new Intent(Intent.ACTION_VIEW, url));
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(this), "AndroidApp");
        setContentView(web);
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl(HOME);
        }
    }

    /** Lets the page hand text (symptom logs, backups) to Android's share sheet. */
    static class Bridge {
        private final MainActivity a;
        Bridge(MainActivity activity) { a = activity; }

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
    }
}
