'use strict';
// A software deadline is not a kernel cleanup proof. Never synthesize close,
// change ownedTree.closed, or signal a saved PID when this deadline expires.
function supervise(child, state, unknown, options) {
  options=options||{};
  const schedule=options.setTimeout||setTimeout,cancel=options.clearTimeout||clearTimeout;
  let timer=null,limit=Infinity,finished=false,uncertain=false,stopped=false;
  function arm(reason,ms) {
    if(finished||uncertain)return;
    const at=Date.now()+ms;if(at>=limit)return;
    cancel(timer);limit=at;
    timer=schedule(()=>{
      timer=null;if(finished||uncertain)return;uncertain=true;
      const error=Object.assign(new Error(reason+'; command result unknown. Agent recovery is required before more work.'),{code:'EOWNERUNKNOWN'});
      state.error=state.error||error.message;
      unknown(error);
    },ms);
  }
  const exit=()=>arm('Broker exited but stdio did not close within 2 seconds',2000);
  child.once('exit',exit);
  return {
    stop(){if(!stopped){stopped=true;arm('Owned process did not settle within 8 seconds of stop',8000);}},
    close(){finished=true;cancel(timer);child.removeListener('exit',exit);},
    get uncertain(){return uncertain;}
  };
}
module.exports={supervise};
