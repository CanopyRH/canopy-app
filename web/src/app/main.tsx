import { createRoot } from "react-dom/client";
import App from "./App";
import "../site/fonts.css";
import "../site/dashboard.css";
import "./app.css";

createRoot(document.getElementById("root")!).render(<App />);
if ("serviceWorker" in navigator && location.protocol === "https:") void navigator.serviceWorker.register("sw.js");
