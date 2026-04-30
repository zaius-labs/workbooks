// Image → depth → motion plan → AI-generated video, all stitched
// together in a single notebook. Depth runs locally via the workbook
// runtime's Candle-ONNX bindings (Depth Anything v2); motion planning
// uses Gemini Flash for prompt drafting; final video synthesis hands
// off to Veo 3.1 Fast via the Google AI Studio API.
export default {
  name: "Image → video — depth-driven animation",
  slug: "image-to-video",
  entry: "index.html",
  type: "notebook",
};
