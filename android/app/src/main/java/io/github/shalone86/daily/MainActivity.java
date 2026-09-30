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
                // Anything else (GitHub token page, links in notes…) opens in the normal browser.
                startActivity(new Intent(Intent.ACTION_VIEW, url));
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "AndroidApp");
        setContentView(web);
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl(HOME);
        }
    }

    /** Lets the page hand text (symptom logs, backups) to Android's share sheet. */
    class Bridge {
        @JavascriptInterface
        public void shareText(final String title, final String text) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType("text/plain");
                    send.putExtra(Intent.EXTRA_SUBJECT, title);
                    send.putExtra(Intent.EXTRA_TEXT, text);
                    startActivity(Intent.createChooser(send, title));
                }
            });
        }
    }

    @Override
    public void onBackPressed() {
        // The page closes an open dialog or returns to Today first; only then does Back leave the app.
        web.evaluateJavascript("window.handleBack ? String(handleBack()) : 'false'", value -> {
            if (!"\"true\"".equals(value)) finish();
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
