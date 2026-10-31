# TRELLIS.2 two-view workflow

The separate workflow is `Tesla_TRELLIS_Two_Views_0_90.json`. Local copy: `tools/comfyui/two-views/Tesla_TRELLIS_Two_Views_0_90.json`. Installed copy: `user/default/workflows/Tesla_TRELLIS_Two_Views_0_90.json` on Tesla ComfyUI.

Load the workflow in ComfyUI and upload the approved front image to **View 1 — Front · 0°** and the approved exact side image to **View 2 — Exact side · 90°**. Keep the inputs independent and make sure both images show the same subject at a matching scale and framing. Supply opaque images already cropped against a plain background; the graph does not invent, rotate, crop, or remove backgrounds. The remaining `view_3` through `view_10` inputs are intentionally empty. The graph is prepared but has no approved reference images attached. Do not queue inference until both views are approved.

The graph uses the live `TeslaTrellis2MultiView` backend type, which requires `view_1` and accepts `view_2` as optional. It uses a conservative V100 profile from the retained settings graph: 512 pipeline, 12 steps, 3000 target faces, 512 texture size, one sample, low VRAM on, tiled decoding off, and 2048 explicit-GEMM chunk size. `max_views` is set to 2. The model preview is connected to Preview3D.

Two-view feature conditioning is experimental and is not calibrated camera reconstruction. The 0°/90° labels describe the submitted reference views; they do not guarantee exact recovered geometry. Only workflow schema and link structure were checked. No model inference, image approval, browser rendering, or 3D output is claimed.
