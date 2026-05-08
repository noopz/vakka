// /cli/:sdkId — slug-less CLI snoop chat view. Mirrors RcRoute: CLI
// sessions whose cwd isn't in the projects table have no slug to route
// through, so they get their own slug-less URL and mount ChatView keyed
// on the SDK session id.
import { useEffect } from "preact/hooks";
import { ChatView } from "../views/chat-view.js";
import { currentSessionId, previewSession } from "../signals/index.js";

export function CliRoute({ sdkId }: { sdkId: string }) {
  if (currentSessionId.value !== sdkId) {
    currentSessionId.value = sdkId;
  }
  if (previewSession.value) previewSession.value = null;
  useEffect(() => () => { currentSessionId.value = null; }, []);
  return <ChatView />;
}
