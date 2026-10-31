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

/**
 * The home-screen to-do list. The page hands over the open tasks ([{id, text, sub}]) whenever they change;
 * they are kept in preferences so the widget works with the app closed. Tapping a circle queues that task as
 * done (and hides it at once); the page checks it off properly the next time the app opens.
 */
public class TodoWidget extends AppWidgetProvider {
    static final String ACTION_DONE = "io.github.shalone86.daily.WIDGET_DONE";
    private static final String PREFS = "widget";
    private static final String KEY_TASKS = "tasks";
    private static final String KEY_DONE = "done";

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

    /** Replaces the task list (leaving out anything already ticked on the widget but not yet saved by the page). */
    static void setTasks(Context c, String json) {
        JSONArray done = read(c, KEY_DONE);
        JSONArray in;
        try {
            in = new JSONArray(json);
        } catch (JSONException e) {
            return;
        }
        JSONArray out = new JSONArray();
        for (int i = 0; i < in.length(); i++) {
            String id = in.optJSONObject(i) == null ? "" : in.optJSONObject(i).optString("id");
            if (!contains(done, id)) out.put(in.optJSONObject(i));
        }
        prefs(c).edit().putString(KEY_TASKS, out.toString()).apply();
        refresh(c);
    }

    private static boolean contains(JSONArray ids, String id) {
        for (int i = 0; i < ids.length(); i++) if (id.equals(ids.optString(i))) return true;
        return false;
    }

    /** Hands the ticked ids to the page and forgets them. */
    static String takeDone(Context c) {
        String out = prefs(c).getString(KEY_DONE, "[]");
        prefs(c).edit().putString(KEY_DONE, "[]").apply();
        return out;
    }

    private static void markDone(Context c, String id) {
        JSONArray done = read(c, KEY_DONE);
        if (!contains(done, id)) done.put(id);
        JSONArray left = new JSONArray();
        JSONArray tasks = read(c, KEY_TASKS);
        for (int i = 0; i < tasks.length(); i++) {
            if (tasks.optJSONObject(i) != null && !id.equals(tasks.optJSONObject(i).optString("id"))) left.put(tasks.optJSONObject(i));
        }
        prefs(c).edit().putString(KEY_DONE, done.toString()).putString(KEY_TASKS, left.toString()).apply();
        refresh(c);
    }

    static void refresh(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] ids = m.getAppWidgetIds(new ComponentName(c, TodoWidget.class));
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
        if (ACTION_DONE.equals(intent.getAction())) {
            String id = intent.getStringExtra("id");
            if (id != null && id.length() > 0) markDone(c, id);
            return;
        }
        super.onReceive(c, intent);
    }

    private static PendingIntent open(Context c, int code, boolean add) {
        Intent i = new Intent(c, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (add) i.putExtra("add_task", true);
        return PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void update(Context c, AppWidgetManager m, int widgetId) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_todo);
        Intent svc = new Intent(c, TodoWidgetService.class);
        svc.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        svc.setData(Uri.parse(svc.toUri(Intent.URI_INTENT_SCHEME)));
        v.setRemoteAdapter(R.id.list, svc);
        v.setEmptyView(R.id.list, R.id.empty);
        int n = read(c, KEY_TASKS).length();
        v.setTextViewText(R.id.title, n > 0 ? "To do · " + n : "To do");
        v.setOnClickPendingIntent(R.id.title, open(c, 1, false));
        v.setOnClickPendingIntent(R.id.empty, open(c, 1, false));
        v.setOnClickPendingIntent(R.id.add, open(c, 2, true));
        Intent done = new Intent(c, TodoWidget.class).setAction(ACTION_DONE);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
        v.setPendingIntentTemplate(R.id.list, PendingIntent.getBroadcast(c, 3, done, flags));
        m.updateAppWidget(widgetId, v);
    }
}
