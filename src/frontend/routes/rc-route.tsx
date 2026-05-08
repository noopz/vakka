// /rc/:cseId — RC-attached chat view. Bypasses the project-slug detour
// because RC sessions don't have a real project_path. Just sets
// currentSessionId and mounts ChatView; the existing message-rendering
// pipeline reads from MQTT-backed messages keyed by session id.
import { useEffect } from "preact/hooks";
import { ChatView } from "../views/chat-view.js";
import { currentSessionId, previewSession } from "../signals/index.js";

export function RcRoute({ cseId }: { cseId: string }) {
  if (currentSessionId.value !== cseId) {
    currentSessionId.value = cseId;
  }
  // ChatView short-circuits to PreviewView whenever previewSession is set,
  // regardless of currentSessionId. A stale preview from a prior CLI tile
  // click would otherwise mask the RC-attached chat. Clear it on entry.
  if (previewSession.value) previewSession.value = null;
  useEffect(() => () => { currentSessionId.value = null; }, []);
  return <ChatView />;
}
