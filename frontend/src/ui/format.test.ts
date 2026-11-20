import { expect, it } from "@rstest/core";
import { ApiError } from "../api/client";
import { errorMessage } from "./format";

it("keeps transport diagnostics private while displaying actionable validation errors", () => {
  expect(errorMessage(new ApiError("synthetic private upstream detail", { status: 502 })))
    .toBe("No confirmed response from the server. Check the current state before trying again.");
  expect(errorMessage(new ApiError("Enter a hostname.", { status: 422 }))).toBe("Enter a hostname.");
});
