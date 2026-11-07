package io.github.shalone86.daily;

import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONArray;
import org.json.JSONObject;

/** Feeds the Limits list widget. */
public class LimitsWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext());
    }

    static class Factory implements RemoteViewsService.RemoteViewsFactory {
        private final Context c;
        private JSONArray items = new JSONArray();

        Factory(Context context) { c = context; }

        @Override public void onCreate() { items = LimitsWidget.read(c, "limits"); }
        @Override public void onDataSetChanged() { items = LimitsWidget.read(c, "limits"); }
        @Override public void onDestroy() {}
        @Override public int getCount() { return items.length(); }

        @Override
        public RemoteViews getViewAt(int position) {
            RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_limit_item);
            JSONObject l = items.optJSONObject(position);
            if (l == null) return v;
            v.setTextViewText(R.id.text, l.optString("name"));
            String sub = l.optString("sub");
            v.setTextViewText(R.id.sub, sub);
            v.setViewVisibility(R.id.sub, sub.length() > 0 ? android.view.View.VISIBLE : android.view.View.GONE);
            v.setTextViewText(R.id.check, l.optString("doseLabel", "+1"));
            Intent fill = new Intent();
            fill.putExtra("id", l.optString("id"));
            v.setOnClickFillInIntent(R.id.check, fill);
            return v;
        }

        @Override public RemoteViews getLoadingView() { return null; }
        @Override public int getViewTypeCount() { return 1; }
        @Override public long getItemId(int position) { return position; }
        @Override public boolean hasStableIds() { return false; }
    }
}
