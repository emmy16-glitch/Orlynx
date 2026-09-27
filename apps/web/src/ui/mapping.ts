// Compatibility facade. The old raw-event switchboard was replaced by the
// canonical agent-stream adapter/store/view architecture under ../agent-stream.
// Keep these exports stable while the rest of Orlynx migrates.
export {
  adapterKind,
  activityTranscriptLabel,
  buildConversationTimeline,
  chatActivities,
  parseTestCounts,
  runTone,
  selectActivities,
  selectLiveReplies,
  toActivities,
  toState,
} from '../agent-stream/view';
export type {
  ActivityItem,
  ActivityState,
  ConversationTimelineEntry,
  LiveReplyView,
} from '../agent-stream/view';
