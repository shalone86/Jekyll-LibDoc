package io.github.shalone86.daily;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Home-screen Limits list widget. Shows active limits and their current status; tapping +dose on a row
 * logs a dose immediately on the home screen and queues it for the page to record when the app opens.
 */
public class LimitsWidget extends AppWidgetProvider {
    static final String ACTION_LOG = "io.github.shalone86.daily.WIDGET_LOG_DOSE";
    private static final String PREFS = "widget";
    private static final String KEY_LIMITS = "limits";
    private static final String KEY_DOSES = "limits_done";

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static JSONArray read(Context c, String key) {
        try {
            return new JSONArray(prefs(c).getString(key, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    static void setLimits(Context c, String json) {
        try {
            JSONArray in = new JSONArray(json);
            prefs(c).edit().putString(KEY_LIMITS, in.toString()).apply();
            refresh(c);
        } catch (JSONException e) {
            // ignore malformed JSON
        }
    }

    static String takeDoses(Context c) {
        String out = prefs(c).getString(KEY_DOSES, "[]");
        prefs(c).edit().putString(KEY_DOSES, "[]").apply();
        return out;
    }

    private static String fmtAmt(double n) {
        long r = Math.round(n * 100);
        if (r % 100 == 0) return String.valueOf(r / 100);
        return String.valueOf(r / 100.0);
    }

    private static String withUnit(double n, String unit) {
        String a = fmtAmt(n);
        return (unit != null && unit.length() > 0) ? a + " " + unit : a;
    }

    private static void logDose(Context c, String id) {
        JSONArray limits = read(c, KEY_LIMITS);
        JSONArray doses = read(c, KEY_DOSES);
        double doseAmt = 1;
        for (int i = 0; i < limits.length(); i++) {
            JSONObject l = limits.optJSONObject(i);
            if (l != null && id.equals(l.optString("id"))) {
                doseAmt = l.optDouble("dose", 1);
                double dayUsed = l.optDouble("dayUsed", 0) + doseAmt;
                double winUsed = l.optDouble("windowUsed", 0) + doseAmt;
                double dayMax = l.optDouble("dayMax", 0);
                double winMax = l.optDouble("windowMax", 0);
                int winHours = l.optInt("windowHours", 0);
                String unit = l.optString("unit", "");
                try {
                    l.put("dayUsed", dayUsed);
                    l.put("windowUsed", winUsed);
                    String state = "OK";
                    if (dayMax > 0 && dayUsed >= dayMax) state = "Done for today";
                    else if (winMax > 0 && winUsed >= winMax) state = "Limit reached";
                    StringBuilder sb = new StringBuilder(state);
                    if (winMax > 0 && winHours > 0) {
                        sb.append(" · Past ").append(winHours).append("h: ").append(fmtAmt(winUsed)).append("/").append(withUnit(winMax, unit));
                    }
                    if (dayMax > 0) {
                        sb.append(" · Today: ").append(fmtAmt(dayUsed)).append("/").append(withUnit(dayMax, unit));
                    } else if (winMax <= 0) {
                        sb.append(" · Today: ").append(withUnit(dayUsed, unit));
                    }
                    l.put("sub", sb.toString());
                } catch (JSONException e) {
                    // ignore
                }
                break;
            }
        }
        try {
            JSONObject entry = new JSONObject();
            entry.put("id", id);
            entry.put("amount", doseAmt);
            entry.put("at", System.currentTimeMillis());
            doses.put(entry);
        } catch (JSONException e) {
            // ignore
        }
        prefs(c).edit()
            .putString(KEY_LIMITS, limits.toString())
            .putString(KEY_DOSES, doses.toString())
            .apply();
        refresh(c);
    }

    static void refresh(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] ids = m.getAppWidgetIds(new ComponentName(c, LimitsWidget.class));
        if (ids.length == 0) return;
        for (int id : ids) update(c, m, id);
        m.notifyAppWidgetViewDataChanged(ids, R.id.list);
    }

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        for (int id : ids) update(c, m, id);
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        if (ACTION_LOG.equals(intent.getAction())) {
            String id = intent.getStringExtra("id");
            if (id != null && id.length() > 0) logDose(c, id);
            return;
        }
        super.onReceive(c, intent);
    }

    private static PendingIntent open(Context c, int code, String viewName) {
        Intent i = new Intent(c, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        i.putExtra("open_view", viewName);
        return PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void update(Context c, AppWidgetManager m, int widgetId) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_limits);
        Intent svc = new Intent(c, LimitsWidgetService.class);
        svc.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        svc.setData(Uri.parse(svc.toUri(Intent.URI_INTENT_SCHEME)));
        v.setRemoteAdapter(R.id.list, svc);
        v.setEmptyView(R.id.list, R.id.empty);
        int n = read(c, KEY_LIMITS).length();
        v.setTextViewText(R.id.title, n > 0 ? "Limits · " + n : "Limits");
        v.setOnClickPendingIntent(R.id.title, open(c, 11, "limits"));
        v.setOnClickPendingIntent(R.id.empty, open(c, 11, "limits"));
        v.setOnClickPendingIntent(R.id.add, open(c, 12, "add_limit"));
        Intent log = new Intent(c, LimitsWidget.class).setAction(ACTION_LOG);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
        v.setPendingIntentTemplate(R.id.list, PendingIntent.getBroadcast(c, 13, log, flags));
        m.updateAppWidget(widgetId, v);
    }
}
