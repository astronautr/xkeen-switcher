import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./catalog-styles";
import { Catalog } from "./catalog/Catalog";
const root = document.getElementById("styleguide");
if (!root) throw new Error("Missing catalog root");
createRoot(root).render(
  <StrictMode>
    <Catalog />
  </StrictMode>,
);
