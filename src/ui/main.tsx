import { createRoot } from "react-dom/client";
import { ModelKitApp } from "./App.js";
import "./styles.css";
const root = document.getElementById("root");
if (root) createRoot(root).render(<ModelKitApp />);
