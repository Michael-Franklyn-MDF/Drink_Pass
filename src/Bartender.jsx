import { useEffect, useRef, useState } from "react";
import BartenderDrinks from "./BartenderDrinks.jsx";
import { DEMO_BARTENDER, formatTime, scanVoucher } from "./eventStore.js";
import { isDemoMode, Screen, ScreenTitle } from "./ui.jsx";

const MESSAGES = {
  accepted: ["✓", "Serve this drink"],
  expired: ["×", "Voucher expired", "Ask the guest to open", "a new voucher."],
  used: ["×", "Already redeemed", "Do not serve another drink."],
  offline: ["!", "No connection", "Don't serve this drink yet.", "Scan not saved. Check your connection."],
  invalid: ["×", "Voucher not recognized", "Don't serve this drink.", "Ask the guest to open a valid voucher."],
  unavailable: ["×", "Drink unavailable", "Don't serve this drink.", "Ask the guest to choose another drink."],
  error: ["!", "Scan not saved", "Don't serve this drink yet.", "Try the scan again."],
};

function useCamera({ enabled, videoRef, onRead, onError }) {
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let stream;
    let frameId;
    const video = videoRef.current;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    function stop() {
      stopped = true;
      window.cancelAnimationFrame(frameId);
      stream?.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    }

    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia || !context) {
          throw new Error("Camera access requires a supported browser on HTTPS or localhost.");
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } }, audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        video.srcObject = stream;
        await video.play();
        const { default: decode } = await import("jsqr");
        if (stopped) return;

        let lastFrameAt = 0;
        function frame(now) {
          if (stopped) return;
          if (now - lastFrameAt >= 120 && video.readyState >= 2 && video.videoWidth > 0) {
            lastFrameAt = now;
            const scale = Math.min(1, 640 / video.videoWidth);
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
            const result = decode(data, width, height, { inversionAttempts: "dontInvert" });
            if (result) {
              stop();
              onRead.current(result.data);
              return;
            }
          }
          frameId = window.requestAnimationFrame(frame);
        }

        frameId = window.requestAnimationFrame(frame);
      } catch (error) {
        if (stopped) return;
        stop();
        onError.current(error.name === "NotAllowedError"
          ? "Camera access was denied. Allow access in your browser and try again."
          : error.name === "NotFoundError"
            ? "No camera was found."
            : !navigator.mediaDevices?.getUserMedia
              ? "Open this page over HTTPS or on localhost to use the camera."
              : "Couldn’t start the camera. Try again.");
      }
    }

    start();
    return stop;
  }, [enabled, onError, onRead, videoRef]);
}

function ScanResult({ result, onNext, onRetry, onManage }) {
  const [icon, title, instruction, detail] = MESSAGES[result.status];
  const { order } = result;
  const accepted = result.status === "accepted";
  const retry = result.status === "offline" || result.status === "error";

  return (
    <Screen role="Bartender">
      <div className="screen-content">
        <ScreenTitle>Scan result</ScreenTitle>
        <div className="scan-result" role="status">
          <span className="scan-symbol" aria-hidden="true">{icon}</span>
          <h2>{title}</h2>
          <p className="scan-primary">{accepted ? order.drink : instruction}</p>
          {detail && <p>{detail}</p>}
          {order && (
            <>
              <p>{order.guest.fullName} · {accepted ? order.guest.identifier : order.drink}</p>
              {accepted && <p>{order.guest.department}</p>}
              <p>{accepted ? "Scanned" : "Redeemed at"} {formatTime(order.scannedAt)}</p>
            </>
          )}
        </div>
      </div>
      <div className="screen-actions bartender-actions">
        <button className="button button-secondary" onClick={onManage}>Manage drinks</button>
        <button className="button button-primary" onClick={retry ? onRetry : onNext}>{retry ? "Try again" : "Scan next"}</button>
      </div>
    </Screen>
  );
}

export default function Bartender() {
  const [managing, setManaging] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [cameraUsed, setCameraUsed] = useState(false);
  const [result, setResult] = useState(null);
  const [cameraError, setCameraError] = useState("");
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const inFlight = useRef(false);
  const lastCode = useRef("");
  const videoRef = useRef(null);
  const onRead = useRef(null);
  const onError = useRef(null);

  async function scan(value) {
    if (inFlight.current) return;
    inFlight.current = true;
    lastCode.current = value;
    setScanning(true);
    setCameraEnabled(false);
    setResult(null);
    const bartender = new URLSearchParams(window.location.search).get("bar")?.trim() || DEMO_BARTENDER;
    try {
      setResult(await scanVoucher(value, bartender));
    } catch {
      setResult({ status: "error" });
    } finally {
      inFlight.current = false;
      setScanning(false);
    }
  }

  useEffect(() => {
    onRead.current = scan;
    onError.current = (message) => {
      setCameraEnabled(false);
      setCameraError(message);
    };
  });
  useCamera({ enabled: cameraEnabled, videoRef, onRead, onError });

  function enableCamera() {
    setCameraError("");
    setCameraUsed(true);
    setCameraEnabled(true);
  }

  function nextScan() {
    setResult(null);
    setCode("");
    if (cameraUsed) enableCamera();
  }

  function manageDrinks() {
    setCameraEnabled(false);
    setManaging(true);
  }

  if (managing) {
    return <BartenderDrinks onBack={() => setManaging(false)} backLabel={result ? "Back to scan result" : "Back to scanner"} />;
  }

  if (result) {
    return <ScanResult result={result} onNext={nextScan} onRetry={() => scan(lastCode.current)} onManage={manageDrinks} />;
  }

  const cameraActive = cameraEnabled && !cameraError;
  return (
    <Screen role="Bartender">
      <div className="screen-content">
        <ScreenTitle description={cameraActive
          ? "Position the guest’s QR code inside the frame."
          : "Allow camera access to scan guest vouchers."}>Scan a voucher</ScreenTitle>
        <div className="scanner-view">
          <video ref={videoRef} muted playsInline aria-label="Camera preview" hidden={!cameraActive} />
          <img className="scanner-guide" src="/assets/scanner-guide.svg" alt="" />
        </div>
        {cameraError && <p className="field-error" role="alert">{cameraError}</p>}
        {scanning && <p className="screen-description" role="status">Checking voucher…</p>}
        {isDemoMode() && (
          <form className="manual-scan" onSubmit={(event) => { event.preventDefault(); scan(code.trim()); }}>
            <label className="field-label" htmlFor="voucher-code">Demo voucher code</label>
            <div>
              <input className="text-field" id="voucher-code" value={code} onChange={(event) => setCode(event.target.value)} />
              <button className="button button-secondary" disabled={!code.trim() || scanning}>Scan code</button>
            </div>
          </form>
        )}
      </div>
      <div className="screen-actions bartender-actions">
        <button className="button button-secondary" disabled={scanning} onClick={manageDrinks}>Manage drinks</button>
        <button className="button button-primary" disabled={scanning} onClick={cameraActive
          ? () => setCameraEnabled(false)
          : enableCamera}>{cameraActive ? "Stop camera" : "Enable camera"}</button>
      </div>
    </Screen>
  );
}
