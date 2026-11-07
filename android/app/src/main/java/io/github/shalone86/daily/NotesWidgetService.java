package io.github.shalone86.daily;

import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONArray;
import org.json.JSONObject;

/** Feeds the Notes list widget. */
public class NotesWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext());
    }

    static class Factory implements RemoteViewsService.RemoteViewsFactory {
        private final Context c;
        private JSONArray items = new JSONArray();

        Factory(Context context) { c = context; }

        @Override public void onCreate() { items = NotesWidget.read(c); }
        @Override public void onDataSetChanged() { items = NotesWidget.read(c); }
        @Override public void onDestroy() {}
        @Override public int getCount() { return items.length(); }

        @Override
        public RemoteViews getViewAt(int position) {
            RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_note_item);
            JSONObject n = items.optJSONObject(position);
            if (n == null) return v;
            v.setTextViewText(R.id.text, n.optString("title"));
            String sub = n.optString("sub");
            v.setTextViewText(R.id.sub, sub);
            v.setViewVisibility(R.id.sub, sub.length() > 0 ? android.view.View.VISIBLE : android.view.View.GONE);
            Intent fill = new Intent();
            fill.putExtra("open_view", "note");
            fill.putExtra("note_id", n.optString("id"));
            v.setOnClickFillInIntent(R.id.row, fill);
            return v;
        }

        @Override public RemoteViews getLoadingView() { return null; }
        @Override public int getViewTypeCount() { return 1; }
        @Override public long getItemId(int position) { return position; }
        @Override public boolean hasStableIds() { return false; }
    }
}
