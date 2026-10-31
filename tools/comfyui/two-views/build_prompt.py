import json
from pathlib import Path
root=Path.cwd()
wf=json.loads((root/'tools/comfyui/two-views/Tesla_TRELLIS_Two_Views_0_90.json').read_text(encoding='utf-8'))
trellis=next(n for n in wf['nodes'] if n['id']==50108)
values=trellis['widgets_values']
api_names=['steps','target_faces','texture_size','normal_mode','normal_angle','remesh','remesh_band','remesh_project','pipeline_type','sampler','generate_texture','num_samples','max_views','preprocess_image','max_num_tokens','sparse_structure_resolution','fill_holes','hole_iterations','hole_structure','hole_fill_algorithm','keep_only_shell','dino_lock','dino_substeps','dino_foundation_cap','low_vram','keep_models_loaded','use_tiled','im2col_chunk_size','ss_steps','ss_sampler','ss_guidance_strength','ss_guidance_rescale','ss_guidance_start','ss_guidance_end','ss_rescale_t','ss_sigma_min','shape_steps','shape_sampler','shape_guidance_strength','shape_guidance_rescale','shape_guidance_start','shape_guidance_end','shape_rescale_t','shape_sigma_min','tex_steps','tex_sampler','tex_guidance_strength','tex_guidance_rescale','tex_guidance_start','tex_guidance_end','tex_rescale_t','tex_sigma_min','uv_angle','uv_refine_iterations','uv_global_iterations','uv_smooth_strength','export_scale','save_latents','verbose','export_progress']
assert len(api_names)==60 and len(values)==62
params=dict(zip(api_names,[values[2],*values[3:]]))
params['texture_size']=1024  # User requested higher texture resolution; keep V100 512 pipeline unchanged.
out=root/'artifacts/model-review/generated';out.mkdir(parents=True,exist_ok=True)
for i,obj in enumerate(['drill','astronaut','oxygen_generator','storage','dome_base','rover']):
    name1=f'{obj}-front.png';name2=f'{obj}-side.png'
    inputs={'view_1':['2001',0],'view_2':['2002',0],'seed':42+i*101,**params}
    prompt={'2001':{'class_type':'LoadImage','inputs':{'image':name1}},'2002':{'class_type':'LoadImage','inputs':{'image':name2}},'50108':{'class_type':'TeslaTrellis2MultiView','inputs':inputs},'1701':{'class_type':'Preview3D','inputs':{'model_file':['50108',0]}}}
    (out/f'{obj}-prompt.json').write_text(json.dumps({'prompt':prompt,'client_id':f'codex-two-views-{obj}'},separators=(',',':')),encoding='utf-8')
print('prepared six prompts (still unqueued):',', '.join(['drill','astronaut','oxygen_generator','storage','dome_base','rover']))
