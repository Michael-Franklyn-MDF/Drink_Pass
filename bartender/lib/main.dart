import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

void main() => runApp(DrinkPassApp(backend: DemoBackend()));

typedef ScannerBuilder = Widget Function(
  BuildContext context,
  ValueChanged<String> onScanned,
);

typedef Drink = ({String id, String name});

class GuestCard {
  const GuestCard(this.name, this.department, this.type, this.drinksLeft);
  final String name;
  final String department;
  final String type;
  final int? drinksLeft;
}

class CardFailure implements Exception {
  const CardFailure(this.reason, {this.retryable = false});
  final String reason;
  final bool retryable;
}

typedef ServedDrink = ({String guest, String drink, DateTime time});

abstract interface class BartenderBackend {
  Future<({GuestCard card, List<Drink> drinks})> lookup(String qr);
  Future<ServedDrink> redeem(String qr, Drink drink);
}

class DemoBackend implements BartenderBackend {
  static const staffCard = 'drink-pass-demo-staff';
  static const managerCard = 'drink-pass-demo-manager';
  static const _menu = [
    (id: 'ginger', name: 'Ginger beer'),
    (id: 'water', name: 'Sparkling water'),
  ];

  final _lastServed = <String, DateTime>{};
  int _remaining = 5;
  bool online = true;

  @override
  Future<({GuestCard card, List<Drink> drinks})> lookup(String qr) async {
    if (!online) throw const CardFailure('No connection', retryable: true);
    final card = switch (qr) {
      staffCard => GuestCard('Alex Kamau', 'Operations', 'Blue · Staff', _remaining),
      managerCard => const GuestCard('Sam Muli', 'Management', 'Gold · Manager', null),
      _ => throw const CardFailure('Card not recognized'),
    };
    return (card: card, drinks: _menu);
  }

  @override
  Future<ServedDrink> redeem(String qr, Drink drink) async {
    final guest = (await lookup(qr)).card;
    final now = DateTime.now();
    final last = _lastServed[qr];
    if (last != null && now.difference(last) < const Duration(minutes: 5)) {
      throw const CardFailure('Please wait five minutes between drinks');
    }
    if (guest.drinksLeft == 0) throw const CardFailure('No drinks left');
    if (qr == staffCard) _remaining -= 1;
    _lastServed[qr] = now;
    return (guest: guest.name, drink: drink.name, time: now);
  }
}

class DrinkPassApp extends StatelessWidget {
  const DrinkPassApp({super.key, required this.backend, this.scannerBuilder});
  final BartenderBackend backend;
  final ScannerBuilder? scannerBuilder;

  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff1c1c1e)),
      scaffoldBackgroundColor: const Color(0xfffdfdfd),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: const Color(0xff1c1c1e),
          foregroundColor: Colors.white,
          minimumSize: const Size.fromHeight(52),
          alignment: Alignment.centerLeft,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
        ),
      ),
    ),
    home: _Bartender(backend: backend, scannerBuilder: scannerBuilder),
  );
}

class _Bartender extends StatefulWidget {
  const _Bartender({required this.backend, this.scannerBuilder});
  final BartenderBackend backend;
  final ScannerBuilder? scannerBuilder;

  @override
  State<_Bartender> createState() => _BartenderState();
}

class _BartenderState extends State<_Bartender> {
  bool _scanning = false;
  bool _working = false;
  GuestCard? _card;
  List<Drink> _drinks = [];
  Drink? _selected;
  ServedDrink? _served;
  CardFailure? _refusal;
  Future<void> Function()? _retry;
  String? _qr;

  Future<void> _run(Future<void> Function() action) async {
    if (_working) return;
    setState(() {
      _working = true;
      _scanning = false;
      _refusal = null;
      _retry = null;
    });
    try {
      await action();
    } on CardFailure catch (failure) {
      if (!mounted) return;
      setState(() {
        _refusal = failure;
        _retry = failure.retryable ? () => _run(action) : null;
      });
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<void> _scan(String qr) => _run(() async {
    final found = await widget.backend.lookup(qr);
    if (!mounted) return;
    setState(() {
      _qr = qr;
      _card = found.card;
      _drinks = found.drinks;
      _selected = null;
    });
  });

  Future<void> _confirm() => _run(() async {
    final result = await widget.backend.redeem(_qr!, _selected!);
    if (mounted) setState(() => _served = result);
  });

  void _next() => setState(() {
    _qr = null;
    _card = null;
    _selected = null;
    _served = null;
    _refusal = null;
    _retry = null;
    _scanning = false;
  });

  @override
  Widget build(BuildContext context) {
    if (_scanning) {
      final camera = widget.scannerBuilder ?? _camera;
      return Scaffold(
        backgroundColor: const Color(0xff1c1c1e),
        body: Stack(
          fit: StackFit.expand,
          children: [
            camera(context, _scan),
            IgnorePointer(child: Center(child: SvgPicture.asset('assets/scanner-guide.svg'))),
            SafeArea(
              child: Align(
                alignment: Alignment.topLeft,
                child: TextButton.icon(
                  style: TextButton.styleFrom(
                    foregroundColor: Colors.white,
                    backgroundColor: const Color(0xff1c1c1e),
                  ),
                  onPressed: _next,
                  icon: const Icon(Icons.arrow_back),
                  label: const Text('Back'),
                ),
              ),
            ),
          ],
        ),
      );
    }
    if (_working) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    if (_served != null || _refusal != null) return _result(context);
    if (_card case final card?) return _confirmScreen(card);

    return _Page(
      heading: 'Scan a card',
      body: [
        const Text('Place the QR code inside the frame.'),
        if (widget.backend is DemoBackend)
          const Text('Demo mode. Drinks are simulated.'),
        const SizedBox(height: 32),
        AspectRatio(
          aspectRatio: 345 / 383,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: const Color(0xff1c1c1e),
              borderRadius: BorderRadius.circular(18),
            ),
            child: Center(child: SvgPicture.asset('assets/scanner-guide.svg')),
          ),
        ),
      ],
      actions: [
        FilledButton(
          onPressed: () => setState(() => _scanning = true),
          child: const Text('Enable camera'),
        ),
        if (widget.backend is DemoBackend)
          TextButton(onPressed: () => _scan(DemoBackend.staffCard), child: const Text('Use sample card')),
      ],
    );
  }

  Widget _camera(BuildContext context, ValueChanged<String> onScanned) {
    return LayoutBuilder(builder: (context, size) => MobileScanner(
      scanWindow: Rect.fromCenter(
        center: Offset(size.maxWidth / 2, size.maxHeight / 2),
        width: 213,
        height: 224,
      ),
      onDetect: (capture) {
        for (final barcode in capture.barcodes) {
          final raw = barcode.rawValue;
          if (barcode.format == BarcodeFormat.qrCode && raw != null && raw.isNotEmpty) {
            onScanned(raw);
            return;
          }
        }
      },
      errorBuilder: (context, error) => const Center(
        child: Padding(
          padding: EdgeInsets.symmetric(horizontal: 24),
          child: Text(
            'Camera unavailable. Check camera permission and try again.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.white),
          ),
        ),
      ),
    ));
  }

  Widget _confirmScreen(GuestCard card) => _Page(
    heading: 'Confirm drink',
    body: [
      Text(card.name, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
      Text(card.department),
      Text(card.type),
      if (card.drinksLeft case final left?) Text('$left drinks left'),
      const SizedBox(height: 24),
      if (_drinks.isEmpty) const Text('No drinks are available.'),
      for (final drink in _drinks)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: ChoiceChip(
            label: Text(drink.name),
            selected: _selected == drink,
            onSelected: card.drinksLeft == 0 ? null : (_) => setState(() => _selected = drink),
            materialTapTargetSize: MaterialTapTargetSize.padded,
          ),
        ),
    ],
    actions: [
      FilledButton(
        onPressed: _selected == null ? null : _confirm,
        child: const Text('Confirm drink'),
      ),
      TextButton(onPressed: _next, child: const Text('Scan another card')),
    ],
  );

  Widget _result(BuildContext context) {
    final served = _served;
    final success = served != null;
    final foreground = success ? const Color(0xff075637) : const Color(0xff8b1d24);
    return _Page(
      heading: 'Scan result',
      body: [
        Semantics(
          liveRegion: true,
          child: Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              color: success ? const Color(0xffddf4e7) : const Color(0xffffe6e7),
              borderRadius: BorderRadius.circular(18),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(success ? Icons.check : Icons.close, color: foreground, size: 32),
                const SizedBox(height: 20),
                Text(
                  success ? 'Serve this drink' : _refusal!.reason,
                  style: TextStyle(color: foreground, fontWeight: FontWeight.bold, fontSize: 27),
                ),
                const SizedBox(height: 12),
                if (served != null) ...[
                  Text(served.drink, style: const TextStyle(fontSize: 19, fontWeight: FontWeight.bold)),
                  Text(served.guest),
                  Text('Scanned ${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(served.time.toLocal()))}'),
                ] else if (_retry != null)
                  const Text('Check your connection and try again before serving.')
                else
                  const Text('Do not serve a drink.'),
              ],
            ),
          ),
        ),
      ],
      actions: [
        FilledButton(onPressed: _retry ?? _next, child: Text(_retry == null ? 'Scan next' : 'Try again')),
      ],
    );
  }
}

class _Page extends StatelessWidget {
  const _Page({required this.heading, required this.body, required this.actions});
  final String heading;
  final List<Widget> body;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 24, 24, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('Drink Pass', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 17)),
                Text('Bartender', style: TextStyle(fontWeight: FontWeight.bold)),
              ],
            ),
            const SizedBox(height: 26),
            Expanded(
              child: ListView(
                children: [
                  Text(heading, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 34)),
                  const SizedBox(height: 12),
                  ...body,
                ],
              ),
            ),
            const SizedBox(height: 12),
            ...actions,
          ],
        ),
      ),
    ),
  );
}
