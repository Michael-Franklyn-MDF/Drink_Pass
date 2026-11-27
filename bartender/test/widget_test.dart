import 'package:drink_pass_bartender/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('scanning opens confirmation and a successful drink stays visible',
      (tester) async {
    await tester.pumpWidget(DrinkPassApp(backend: DemoBackend()));
    await tester.tap(find.text('Use sample card'));
    await tester.pumpAndSettle();

    expect(find.text('Alex Kamau'), findsOneWidget);
    expect(find.text('5 drinks left'), findsOneWidget);
    expect(find.text('Serve this drink'), findsNothing);

    await tester.tap(find.text('Ginger beer'));
    await tester.pump();
    await tester.tap(find.text('Confirm drink'));
    await tester.pumpAndSettle();

    expect(find.text('Serve this drink'), findsOneWidget);
    expect(find.text('Alex Kamau'), findsOneWidget);
    expect(find.text('Ginger beer'), findsOneWidget);
    expect(find.textContaining('Scanned '), findsOneWidget);

    await tester.tap(find.text('Scan next'));
    await tester.pumpAndSettle();
    expect(find.text('Scan a card'), findsOneWidget);
  });

  testWidgets('an unavailable connection can be retried', (tester) async {
    final backend = DemoBackend()..online = false;
    await tester.pumpWidget(DrinkPassApp(backend: backend));
    await tester.tap(find.text('Use sample card'));
    await tester.pumpAndSettle();

    expect(find.text('No connection'), findsOneWidget);
    expect(find.text('Serve this drink'), findsNothing);

    backend.online = true;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('Confirm drink'), findsOneWidget);
  });

  testWidgets('a manager card shows its type without an allowance',
      (tester) async {
    await tester.pumpWidget(DrinkPassApp(
      backend: DemoBackend(),
      scannerBuilder: (_, scanned) => TextButton(
        onPressed: () => scanned(DemoBackend.managerCard),
        child: const Text('Read manager card'),
      ),
    ));
    await tester.tap(find.text('Enable camera'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Read manager card'));
    await tester.pumpAndSettle();

    expect(find.text('Gold · Manager'), findsOneWidget);
    expect(find.textContaining('drinks left'), findsNothing);
  });

  testWidgets('an invalid card produces a refusal with no serve action',
      (tester) async {
    await tester.pumpWidget(DrinkPassApp(
      backend: DemoBackend(),
      scannerBuilder: (_, scanned) => TextButton(
        onPressed: () => scanned('unknown'),
        child: const Text('Read unknown card'),
      ),
    ));
    await tester.tap(find.text('Enable camera'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Read unknown card'));
    await tester.pumpAndSettle();

    expect(find.text('Card not recognized'), findsOneWidget);
    expect(find.text('Do not serve a drink.'), findsOneWidget);
    expect(find.text('Scan next'), findsOneWidget);
    expect(find.text('Serve this drink'), findsNothing);
  });
}
