// Browser bundle of the pieces of matrix-js-sdk a 1:1 VoIP call needs.
import * as sdk from 'matrix-js-sdk';
import { CallEvent, CallState, CallErrorCode } from 'matrix-js-sdk/lib/webrtc/call.js';
import { CallEventHandlerEvent } from 'matrix-js-sdk/lib/webrtc/callEventHandler.js';
import { CallFeedEvent } from 'matrix-js-sdk/lib/webrtc/callFeed.js';
window.MX = { sdk, CallEvent, CallState, CallErrorCode, CallEventHandlerEvent, CallFeedEvent };
