# Drink Pass bartender

The current Flutter app runs with a demo backend. It exercises the Scan, Confirm,
Result, and connection retry screens. Demo drinks are stored only in memory.

From this directory, run:

```sh
flutter pub get
flutter test
flutter run
```

Tap **Use sample card** to try the flow without a camera. To test the camera,
scan a QR containing `drink-pass-demo-staff` or `drink-pass-demo-manager`.
An unrelated QR should show the refusal screen.
