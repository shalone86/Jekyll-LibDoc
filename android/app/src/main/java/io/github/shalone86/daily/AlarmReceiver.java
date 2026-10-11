package io.github.shalone86.daily;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Fires when a reminder is due (or when Snooze is tapped on its notification). */
public class AlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra("id");
        if (id == null) return;
        String title = intent.getStringExtra("title");
        if (title == null) title = "Something to do";
        boolean loud = intent.getBooleanExtra("loud", false);
        if (Reminders.ACTION_SNOOZE.equals(intent.getAction())) {
            Reminders.snooze(context, id, title, loud);
        } else {
            Reminders.show(context, id, title, loud);
        }
    }
}
