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
 * Home-screen Notes list widget. Shows recent notes; tapping a note opens it directly in the editor,
 * and tapping + starts a brand-new note.
 */
public class NotesWidget extends AppWidgetProvider {
    private static final String PREFS = "widget";
    private static final String KEY_NOTES = "notes";

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static JSONArray read(Context c) {
        try {
            return new JSONArray(prefs(c).getString(KEY_NOTES, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    static void setNotes(Context c, String json) {
        try {
            JSONArray in = new JSONArray(json);
            prefs(c).edit().putString(KEY_NOTES, in.toString()).apply();
            refresh(c);
        } catch (JSONException e) {
            // ignore malformed JSON
        }
    }

    static void refresh(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] ids = m.getAppWidgetIds(new ComponentName(c, NotesWidget.class));
        if (ids.length == 0) return;
        for (int id : ids) update(c, m, id);
        m.notifyAppWidgetViewDataChanged(ids, R.id.list);
    }

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        for (int id : ids) update(c, m, id);
    }

    private static PendingIntent open(Context c, int code, String viewName) {
        Intent i = new Intent(c, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        i.putExtra("open_view", viewName);
        return PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void update(Context c, AppWidgetManager m, int widgetId) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_notes);
        Intent svc = new Intent(c, NotesWidgetService.class);
        svc.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        svc.setData(Uri.parse(svc.toUri(Intent.URI_INTENT_SCHEME)));
        v.setRemoteAdapter(R.id.list, svc);
        v.setEmptyView(R.id.list, R.id.empty);
        int n = read(c).length();
        v.setTextViewText(R.id.title, n > 0 ? "Notes · " + n : "Notes");
        v.setOnClickPendingIntent(R.id.title, open(c, 21, "notes"));
        v.setOnClickPendingIntent(R.id.empty, open(c, 21, "notes"));
        v.setOnClickPendingIntent(R.id.add, open(c, 22, "new_note"));
        Intent itemOpen = new Intent(c, MainActivity.class);
        itemOpen.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
        v.setPendingIntentTemplate(R.id.list, PendingIntent.getActivity(c, 23, itemOpen, flags));
        m.updateAppWidget(widgetId, v);
    }
}
