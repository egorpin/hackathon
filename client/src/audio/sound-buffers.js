// Original procedural recordings, generated once and reused by Web Audio.
export function makeSamples(kind, sampleRate = 24000) {
  const duration = {step:.22,hammer:.42,drill:4,oxygen_generator:4}[kind] || 4;
  const data = new Float32Array(Math.round(duration * sampleRate));
  let seed=731, low=0, previous=0;
  for(let i=0;i<data.length;i++){
    const t=i/sampleRate;
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const noise=seed/2147483648-1;
    low+=.12*(noise-low);
    const grain=noise-previous;previous=noise;
    if(kind==='step'){
      const impact=Math.exp(-t*42);
      const crunch=Math.sin(Math.PI*t/duration)**2*Math.exp(-t*9);
      data[i]=.6*low*impact+.18*Math.sin(2*Math.PI*145*t)*impact+.32*grain*crunch;
    }else if(kind==='hammer'){
      for(const start of [0,.18]){
        const a=t-start;
        if(a>=0)data[i]+=.32*noise*Math.exp(-a*100)+.22*Math.sin(2*Math.PI*760*a)*Math.exp(-a*45)+.13*Math.sin(2*Math.PI*195*a)*Math.exp(-a*32);
      }
    }else if(kind==='drill'){
      // Rounded engine pulses and filtered mechanical air, no sawtooth drone.
      const pulse=.55+.45*Math.sin(2*Math.PI*18*t);
      data[i]=.13*Math.sin(2*Math.PI*108*t)*pulse+.07*Math.sin(2*Math.PI*216*t)+.32*low*pulse;
    }else if(kind==='oxygen_generator'){
      // Slow compressor breathing with a short pressure-release hiss each cycle.
      const phase=t%2, breath=.35+.65*Math.sin(Math.PI*phase/2)**2;
      const vent=phase>1.5?Math.sin(Math.PI*(phase-1.5)/.5)**2:0;
      data[i]=.09*Math.sin(2*Math.PI*180*t)*breath+.35*low*breath+.08*noise*vent;
    }else data[i]=.08*Math.sin(2*Math.PI*120*t)+.22*low;
    if(duration===4)data[i]*=Math.min(1,t/.015,(duration-t)/.015);
  }
  return data;
}
