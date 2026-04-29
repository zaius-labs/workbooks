// Trigger-substring-safe HTML emission.
//
// The HTML parser, while inside <script>, runs a state machine that
// transitions on these substrings:
//
//   <!--    enters "script data escaped"
//   -->     exits back to "script data" (from the dash-dash sub-states)
//   <script (in escaped state) → "script data double escaped" where
//           </script> is INERT until -->
//   </script  closes the script in either data or escaped state
//
// If a generated script's source contains any of these literally, the
// page's own parser may close the script earlier than intended and
// dump the remainder as body text — which is the bug we hit when
// chat-app's saved .workbook.html broke.
//
// Mitigation: never write these substrings into source. Build them at
// runtime by string concatenation. Helpers below produce the same
// strings without any literal trigger appearing in this source.

export const TRIGGER = {
  COM_OPEN:        () => "<" + "!" + "--",
  COM_CLOSE:       () => "--" + ">",
  STYLE_CLOSE:     () => "<" + "/style>",
  HEAD_CLOSE:      () => "<" + "/head>",
  TAG_SCRIPT_OPEN: () => "<" + "script",
  TAG_SCRIPT_END:  () => "<" + "/script>",
};

/** Make a string safe to embed inside a <script> body — escape any
 * `</script` substring (case-insensitive). Use for asset bodies that
 * we inline as text/plain script content. */
export function escapeForScript(s) {
  return String(s).replace(/<\/script/gi, "<\\/script");
}

/** Build the portable-assets sentinel comments. */
export function makeSentinels() {
  return {
    BEGIN: TRIGGER.COM_OPEN() + " portable-assets-begin " + TRIGGER.COM_CLOSE(),
    END:   TRIGGER.COM_OPEN() + " portable-assets-end "   + TRIGGER.COM_CLOSE(),
  };
}

/** Slot marker injected into <head> during the early HTML transform.
 *  Later passes locate THIS string (instead of </head>) when inserting
 *  the portable-assets block, so a user JS bundle containing the
 *  literal substring "</head>" — common in iframe srcdoc helpers —
 *  cannot fool the injector into landing assets inside a JS template
 *  literal. Closes core-bii. */
export const SLOT_PORTABLE = TRIGGER.COM_OPEN()
  + " @workbook:slot:portable-assets " + TRIGGER.COM_CLOSE();

/** Build a single inlined-asset script block. */
export function makeAssetTag(id, type, body) {
  const open = TRIGGER.TAG_SCRIPT_OPEN();
  const close = TRIGGER.TAG_SCRIPT_END();
  return `${open} id="${id}" type="${type}">${body}${close}`;
}
