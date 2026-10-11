package io.github.shalone86.daily;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Reminders that ring with the app closed. The page hands over every upcoming reminder
 * ({id, at, title, loud}); each becomes an Android alarm that posts a notification.
 * They are also kept in preferences so they can be set again after a reboot.
 */
final class Reminders {
    static final String ACTION_REMIND = "io.github.shalone86.daily.REMIND";
    static final String ACTION_SNOOZE = "io.github.shalone86.daily.SNOOZE";
    private static final String PREFS = "reminders";
    private static final String KEY_LIST = "list";
    private static final String KEY_SNOOZED = "snoozed";
    private static final String CH_NORMAL = "reminders";
    private static final String CH_LOUD = "reminders_loud";
    static final long SNOOZE_MS = 10 * 60 * 1000L;

    private Reminders() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static JSONArray read(Context c, String key) {
        try {
            return new JSONArray(prefs(c).getString(key, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    private static void write(Context c, String key, JSONArray list) {
        prefs(c).edit().putString(key, list.toString()).apply();
    }

    /** Replaces everything with the page's list. Snoozes survive only while their reminder is unchanged. */
    static void replaceAll(Context c, String json) {
        JSONArray incoming;
        try {
            incoming = new JSONArray(json);
        } catch (JSONException e) {
            return;
        }
        cancelAll(c);
        long now = System.currentTimeMillis();
        JSONArray keep = new JSONArray();
        JSONArray snoozed = read(c, KEY_SNOOZED);
        JSONArray snoozeKeep = new JSONArray();
        for (int i = 0; i < incoming.length(); i++) {
            JSONObject o = incoming.optJSONObject(i);
            if (o == null || o.optString("id").length() == 0) continue;
            JSONObject snooze = find(snoozed, o.optString("id"));
            if (snooze != null && snooze.optLong("orig") == o.optLong("at")) {
                snoozeKeep.put(snooze);
                if (snooze.optLong("at") > now) schedule(c, snooze);
            } else if (o.optLong("at") > now) {
                keep.put(o);
                schedule(c, o);
            }
            // A reminder that already rang (and wasn't snoozed) isn't kept.
            if (o.optLong("at") <= now && snooze == null) keep.put(o);
        }
        write(c, KEY_LIST, keep);
        write(c, KEY_SNOOZED, snoozeKeep);
    }

    /** After a reboot or an app update, alarms are gone: set the future ones again. */
    static void rescheduleAll(Context c) {
        long now = System.currentTimeMillis();
        String[] keys = {KEY_LIST, KEY_SNOOZED};
        for (int k = 0; k < keys.length; k++) {
            JSONArray list = read(c, keys[k]);
            for (int i = 0; i < list.length(); i++) {
                JSONObject o = list.optJSONObject(i);
                if (o != null && o.optLong("at") > now) schedule(c, o);
            }
        }
    }

    private static JSONObject find(JSONArray list, String id) {
        for (int i = 0; i < list.length(); i++) {
            JSONObject o = list.optJSONObject(i);
            if (o != null && id.equals(o.optString("id"))) return o;
        }
        return null;
    }

    private static void cancelAll(Context c) {
        String[] keys = {KEY_LIST, KEY_SNOOZED};
        for (int k = 0; k < keys.length; k++) {
            JSONArray list = read(c, keys[k]);
            for (int i = 0; i < list.length(); i++) {
                JSONObject o = list.optJSONObject(i);
                if (o != null) cancel(c, o.optString("id"));
            }
        }
    }

    private static PendingIntent alarmIntent(Context c, String id, JSONObject o) {
        Intent i = new Intent(c, AlarmReceiver.class);
        i.setAction(ACTION_REMIND);
        i.setData(Uri.parse("daily-reminder://" + Uri.encode(id)));
        i.putExtra("id", id);
        if (o != null) {
            i.putExtra("title", o.optString("title"));
            i.putExtra("loud", o.optBoolean("loud"));
        }
        return PendingIntent.getBroadcast(c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void schedule(Context c, JSONObject o) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        PendingIntent p = alarmIntent(c, o.optString("id"), o);
        long at = o.optLong("at");
        try {
            if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, p);
            } else {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, p);
            }
        } catch (SecurityException e) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, p);
        }
    }

    static void cancel(Context c, String id) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        PendingIntent p = alarmIntent(c, id, null);
        am.cancel(p);
        p.cancel();
    }

    /** "Snooze 10 min" on the notification: ring again later. */
    static void snooze(Context c, String id, String title, boolean loud) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.cancel(id.hashCode());
        long now = System.currentTimeMillis();
        JSONArray snoozed = read(c, KEY_SNOOZED);
        long orig = now;
        JSONObject old = find(snoozed, id);
        if (old != null) orig = old.optLong("orig");
        else {
            JSONObject listed = find(read(c, KEY_LIST), id);
            if (listed != null) orig = listed.optLong("at");
        }
        JSONArray next = new JSONArray();
        for (int i = 0; i < snoozed.length(); i++) {
            JSONObject o = snoozed.optJSONObject(i);
            if (o != null && !id.equals(o.optString("id"))) next.put(o);
        }
        try {
            JSONObject s = new JSONObject();
            s.put("id", id);
            s.put("title", title);
            s.put("loud", loud);
            s.put("at", now + SNOOZE_MS);
            s.put("orig", orig);
            next.put(s);
            write(c, KEY_SNOOZED, next);
            schedule(c, s);
        } catch (JSONException e) { /* can't happen: plain keys */ }
    }

    private static void ensureChannels(NotificationManager nm) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel normal = new NotificationChannel(CH_NORMAL, "Reminders", NotificationManager.IMPORTANCE_HIGH);
        normal.setDescription("Reminders you set on to-dos");
        normal.enableVibration(true);
        nm.createNotificationChannel(normal);

        NotificationChannel loud = new NotificationChannel(CH_LOUD, "Alarm-style reminders", NotificationManager.IMPORTANCE_HIGH);
        loud.setDescription("Reminders set to ring like an alarm");
        loud.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        loud.enableVibration(true);
        loud.setVibrationPattern(new long[] {0, 600, 300, 600, 300, 600});
        nm.createNotificationChannel(loud);
    }

    static void show(Context c, String id, String title, boolean loud) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        ensureChannels(nm);
        int icon = c.getResources().getIdentifier("ic_notify", "drawable", c.getPackageName());
        if (icon == 0) icon = android.R.drawable.ic_popup_reminder;

        Intent open = new Intent(c, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(c, id.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent snooze = new Intent(c, AlarmReceiver.class);
        snooze.setAction(ACTION_SNOOZE);
        snooze.setData(Uri.parse("daily-snooze://" + Uri.encode(id)));
        snooze.putExtra("id", id);
        snooze.putExtra("title", title);
        snooze.putExtra("loud", loud);
        PendingIntent snoozePi = PendingIntent.getBroadcast(c, 0, snooze, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(c, loud ? CH_LOUD : CH_NORMAL)
                : new Notification.Builder(c);
        b.setSmallIcon(icon)
                .setContentTitle("Reminder")
                .setContentText(title)
                .setStyle(new Notification.BigTextStyle().bigText(title))
                .setContentIntent(content)
                .setAutoCancel(true)
                .setCategory(loud ? Notification.CATEGORY_ALARM : Notification.CATEGORY_REMINDER)
                .addAction(new Notification.Action.Builder(Icon.createWithResource(c, icon), "Snooze 10 min", snoozePi).build());
        if (Build.VERSION.SDK_INT < 26) {
            b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
            if (loud) b.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM));
        }
        try {
            nm.notify(id.hashCode(), b.build());
        } catch (SecurityException e) { /* notifications not allowed */ }
    }

    /** "ok", "notifications-off" or "exact-off" — what the page shows beside the reminder. */
    static String status(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (!nm.areNotificationsEnabled()) return "notifications-off";
        if (Build.VERSION.SDK_INT >= 31) {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            if (!am.canScheduleExactAlarms()) return "exact-off";
        }
        return "ok";
    }
}
