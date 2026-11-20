import { StaleSessionError } from "../../api/client";
import { useNotifications } from "../../app/AppSessionProvider";
import { errorMessage } from "../../ui/format";

export function useActionFeedback() {
  const { publish } = useNotifications();
  return async function report<T>(
    request: Promise<T>,
    message: (result: T) => string,
    failed?: (result: T) => boolean,
  ) {
    try {
      const result = await request;
      publish(message(result), failed?.(result));
    } catch (error) {
      if (!(error instanceof StaleSessionError)) publish(errorMessage(error), true);
    }
  };
}
