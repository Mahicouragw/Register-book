package com.registerbook.community;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the app's own plugins BEFORE the bridge is created, so the
        // JavaScript side can call Capacitor.Plugins.ApkUpdater immediately.
        registerPlugin(ApkUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
