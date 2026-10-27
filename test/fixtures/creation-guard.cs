// Diagnostic fixture only, CLR2. Never used by the production launcher.
// The target inherits this external Job before the instrumented broker can
// create it. All termination uses owned handles; PID is only an input to
// OpenProcess followed by Job/creation-identity verification.
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
internal static class CreationGuard {
    [StructLayout(LayoutKind.Sequential)] struct Startup {
        public int cb; public IntPtr reserved, desktop, title;
        public int x,y,width,height,charsX,charsY,fill,flags;
        public short show,reservedSize; public IntPtr reserved2,stdin,stdout,stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct Info { public IntPtr process,thread; public uint pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long processTime,jobTime; public uint flags; public UIntPtr min,max;
        public uint active; public UIntPtr affinity; public uint priority,scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimits basic; public Io io; public UIntPtr a,b,c,d; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting { public long a,b,c,d; public uint faults,total,active,terminated; }
    [StructLayout(LayoutKind.Sequential)] struct Time { public uint low,high; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr a,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref Limits info,int size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out Accounting info,int size,IntPtr returned);
    [DllImport("kernel32.dll",EntryPoint="QueryInformationJobObject",SetLastError=true)] static extern bool QueryList(IntPtr job,int type,IntPtr info,int size,IntPtr returned);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr process,uint flags,StringBuilder name,ref uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out Info info);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out Time created,out Time exited,out Time kernel,out Time user);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr destination,out IntPtr copy,uint access,bool inherit,uint flags);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static readonly object gate=new object(); static IntPtr job=IntPtr.Zero;
    static void Need(bool ok,string label) { if(!ok)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),label); }
    static ulong Birth(IntPtr process) { Time c,e,k,u;Need(GetProcessTimes(process,out c,out e,out k,out u),"birth");return ((ulong)c.high<<32)|c.low; }
    static Accounting Count() { Accounting a;Need(QueryInformationJobObject(job,1,out a,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),"count");return a; }
    static string Members() {
        int size=8+16*IntPtr.Size;IntPtr memory=Marshal.AllocHGlobal(size);
        try {
            Need(QueryList(job,3,memory,size,IntPtr.Zero),"member-list");int count=Marshal.ReadInt32(memory,4);if(count<0||count>16)throw new Exception("member-budget");
            StringBuilder result=new StringBuilder();
            for(int i=0;i<count;i++) {
                uint pid=(uint)Marshal.ReadIntPtr(memory,8+i*IntPtr.Size).ToInt64();IntPtr p=OpenProcess(0x1000,false,pid);
                string name="exited";
                if(p!=IntPtr.Zero)try{bool inside;if(IsProcessInJob(p,job,out inside)&&inside){StringBuilder image=new StringBuilder(2048);uint n=2048;if(QueryFullProcessImageNameW(p,0,image,ref n))name=System.IO.Path.GetFileName(image.ToString());}}finally{CloseHandle(p);}
                if(i>0)result.Append(',');result.Append(pid+":"+name);
            }
            return result.ToString();
        } finally { Marshal.FreeHGlobal(memory); }
    }
    static void Empty() {
        lock(gate) {
            if(job==IntPtr.Zero)return;
            Need(TerminateJobObject(job,194),"empty");
            System.Diagnostics.Stopwatch clock=System.Diagnostics.Stopwatch.StartNew();
            while(Count().active!=0) { if(clock.ElapsedMilliseconds>=5000)throw new Exception("cleanup-unconfirmed");Thread.Sleep(10); }
        }
    }
    static int Inspect(string[] args) {
        if(args.Length!=7)throw new Exception("inspect-arguments");
        IntPtr parent=IntPtr.Zero,target=IntPtr.Zero;
        try {
            parent=OpenProcess(0x101040,false,uint.Parse(args[1]));Need(parent!=IntPtr.Zero,"inspect-parent");
            if(Birth(parent)!=ulong.Parse(args[2])||WaitForSingleObject(parent,0)!=258)throw new Exception("parent-identity-mismatch");
            bool consume=args[6]=="consume";
            Need(DuplicateHandle(parent,new IntPtr(long.Parse(args[3])),GetCurrentProcess(),out target,0,false,consume?3u:2u),"inspect-handle");
            if(GetProcessId(target)!=uint.Parse(args[4])||Birth(target)!=ulong.Parse(args[5]))throw new Exception("target-identity-mismatch");
            uint wait=WaitForSingleObject(target,consume?5000u:0u);
            if(wait==258 && consume) {
                // Cleanup remains handle-bound even if the external Job failed.
                Need(TerminateProcess(target,195),"recover-owned-target");Need(WaitForSingleObject(target,5000)==0,"recover-wait");
                Console.WriteLine("RECOVERED");return 2;
            }
            Need(wait==0||wait==258,"inspect-wait");uint code;Need(GetExitCodeProcess(target,out code),"inspect-exit");
            Console.WriteLine(wait==0?"EXIT "+code:"ALIVE");return 0;
        } finally { if(target!=IntPtr.Zero)CloseHandle(target);if(parent!=IntPtr.Zero)CloseHandle(parent); }
    }
    // Candidate mechanism only: one strict Job, containing the creator itself.
    // Query the Job membership, not a saved PID/process-tree snapshot.
    static uint[] MemberIds() {
        for(int capacity=16;capacity<=4096;capacity*=2) {
            int size=8+capacity*IntPtr.Size;IntPtr memory=Marshal.AllocHGlobal(size);
            try {
                bool ok=QueryList(job,3,memory,size,IntPtr.Zero);int error=Marshal.GetLastWin32Error();
                if(!ok) { if(error==234)continue;throw new System.ComponentModel.Win32Exception(error,"self-members"); }
                int assigned=Marshal.ReadInt32(memory,0),count=Marshal.ReadInt32(memory,4);
                if(count<0||count>capacity||assigned<0)throw new Exception("self-member-count");
                if(assigned>count)continue;
                uint[] ids=new uint[count];for(int i=0;i<count;i++)ids[i]=(uint)Marshal.ReadIntPtr(memory,8+i*IntPtr.Size).ToInt64();return ids;
            } finally { Marshal.FreeHGlobal(memory); }
        }
        throw new Exception("self-member-budget");
    }
    static void OnlySelf() {
        uint self=GetCurrentProcessId();System.Diagnostics.Stopwatch clock=System.Diagnostics.Stopwatch.StartNew();
        for(;;) {
            if(clock.ElapsedMilliseconds>=5000)throw new Exception("self-cleanup-deadline");
            uint[] ids=MemberIds();
            if(ids.Length==1&&ids[0]==self&&Count().active==1)return;
            foreach(uint pid in ids) {
                if(pid==self)continue;
                if(clock.ElapsedMilliseconds>=5000)throw new Exception("self-cleanup-deadline");
                IntPtr process=OpenProcess(0x101001,false,pid);
                if(process==IntPtr.Zero) { int error=Marshal.GetLastWin32Error();if(error==87)continue;throw new System.ComponentModel.Win32Exception(error,"self-open-member"); }
                try {
                    bool inside;Need(IsProcessInJob(process,job,out inside),"self-member-identity");
                    if(!inside||WaitForSingleObject(process,0)==0)continue;
                    if(!TerminateProcess(process,196)&&WaitForSingleObject(process,0)!=0)Need(false,"self-stop-member");
                } finally { CloseHandle(process); }
            }
            Thread.Sleep(10);
        }
    }
    static void Export(IntPtr process,IntPtr parent,string label) {
        IntPtr remote;Need(DuplicateHandle(GetCurrentProcess(),process,parent,out remote,0,false,2),"self-export");
        Console.WriteLine(label+" "+GetProcessId(process)+" "+remote.ToInt64()+" "+Birth(process));Console.Out.Flush();
    }
    static int Self(string[] args) {
        IntPtr parent=IntPtr.Zero;Info target=new Info();Timer deadline=null;
        try {
            if(args.Length!=4)throw new Exception("self-arguments");
            string startupGate=Environment.GetEnvironmentVariable("SELF_JOB_GATE");
            if(!String.IsNullOrEmpty(startupGate)) {
                System.Diagnostics.Stopwatch startupClock=System.Diagnostics.Stopwatch.StartNew();
                while(!System.IO.File.Exists(startupGate)) {if(startupClock.ElapsedMilliseconds>=10000)throw new Exception("self-startup-deadline");Thread.Sleep(10);}
            }
            bool existing;Need(IsProcessInJob(GetCurrentProcess(),IntPtr.Zero,out existing),"self-host-job");
            if(existing&&Environment.GetEnvironmentVariable("SELF_JOB_REQUIRE_EMPTY_HOST")=="1")throw new Exception("self-existing-job");
            parent=OpenProcess(0x101040,false,uint.Parse(args[1]));Need(parent!=IntPtr.Zero,"self-parent");
            job=CreateJobObjectW(IntPtr.Zero,null);Need(job!=IntPtr.Zero,"self-job");
            Limits limits=new Limits();limits.basic.flags=0x2000;
            Need(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(Limits))),"self-limits");
            Need(AssignProcessToJobObject(job,GetCurrentProcess()),"self-assign");
            deadline=new Timer(delegate(object unused){Environment.Exit(124);},null,30000,Timeout.Infinite);
            Console.WriteLine("SELF_READY "+Birth(parent)+" "+(existing?"1":"0"));Console.Out.Flush();string line;
            while((line=Console.ReadLine())!=null) {
                if(line=="CREATE") {
                    if(target.process!=IntPtr.Zero)throw new Exception("self-already-created");
                    Startup startup=new Startup();startup.cb=Marshal.SizeOf(typeof(Startup));startup.flags=0x100;
                    startup.stdin=GetStdHandle(-10);startup.stdout=GetStdHandle(-11);startup.stderr=GetStdHandle(-12);
                    string app=Encoding.Unicode.GetString(Convert.FromBase64String(args[2])),command=Encoding.Unicode.GetString(Convert.FromBase64String(args[3]));
                    Need(CreateProcessW(app,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,4u|0x08000000u,IntPtr.Zero,null,ref startup,out target),"self-create");
                    bool inside;Need(IsProcessInJob(target.process,job,out inside)&&inside,"self-target-inherited");
                    Export(target.process,parent,"SELF_TARGET");
                } else if(line=="RESUME") {
                    Need(target.thread!=IntPtr.Zero&&ResumeThread(target.thread)!=0xffffffff,"self-resume");Console.WriteLine("SELF_RUNNING");Console.Out.Flush();
                } else if(line.StartsWith("CAPTURE ")) {
                    uint pid=uint.Parse(line.Substring(8));if(pid==GetCurrentProcessId())throw new Exception("self-capture-creator");
                    IntPtr p=OpenProcess(0x101001,false,pid);Need(p!=IntPtr.Zero,"self-capture");
                    try { bool inside;Need(IsProcessInJob(p,job,out inside)&&inside,"self-capture-member");Export(p,parent,"SELF_CAPTURE"); }finally {CloseHandle(p);}
                } else if(line=="CLEANUP") {
                    OnlySelf();Console.WriteLine("ONLY_SELF 1");Console.Out.Flush();
                } else if(line=="EXIT")return 37;
                else throw new Exception("self-command");
            }
            return 125;
        } catch(Exception e) {Console.Error.WriteLine("SELF_ERROR "+e.Message);return 125;}
        finally {
            if(deadline!=null)deadline.Dispose();
            foreach(IntPtr h in new IntPtr[]{target.thread,target.process,parent})if(h!=IntPtr.Zero)CloseHandle(h);
            // After successful self-assignment the OS must close the sole Job
            // handle during process teardown. Explicit CloseHandle here would
            // kill this process before Main can publish its selected exit code.
            // Before assignment failure an empty Job also dies at process exit.
        }
    }
    static int Main(string[] args) {
        if(args.Length>0&&args[0]=="self")return Self(args);
        IntPtr parent=IntPtr.Zero,target=IntPtr.Zero;Info broker=new Info();Timer deadline=null;
        try {
            if(args.Length>0&&args[0]=="inspect")return Inspect(args);
            if(args.Length!=4||args[0]!="guard")throw new Exception("guard-arguments");
            parent=OpenProcess(0x101040,false,uint.Parse(args[3]));Need(parent!=IntPtr.Zero,"open-parent");
            ulong parentBirth=Birth(parent);
            job=CreateJobObjectW(IntPtr.Zero,null);Need(job!=IntPtr.Zero,"guard-job");
            Limits limits=new Limits();limits.basic.flags=0x2000;
            Need(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(Limits))),"guard-limits");
            deadline=new Timer(delegate(object unused) { try { Empty(); } finally { Environment.Exit(124); } },null,45000,Timeout.Infinite);
            Startup startup=new Startup();startup.cb=Marshal.SizeOf(typeof(Startup));startup.flags=0x100;
            startup.stdin=GetStdHandle(-10);startup.stdout=GetStdHandle(-11);startup.stderr=GetStdHandle(-12);
            string command=Encoding.Unicode.GetString(Convert.FromBase64String(args[2]));
            Need(WaitForSingleObject(parent,0)==258,"parent-still-live");
            Need(CreateProcessW(args[1],new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08000000,IntPtr.Zero,null,ref startup,out broker),"guard-create-broker");
            // Broker is running, but its START is held by the JS controller
            // until this assignment succeeds. No user target exists yet.
            Need(AssignProcessToJobObject(job,broker.process),"guard-assign-broker");
            Console.WriteLine("GUARDED "+broker.pid+" "+parentBirth);Console.Out.Flush();
            IntPtr brokerRemote;Need(DuplicateHandle(GetCurrentProcess(),broker.process,parent,out brokerRemote,0,false,2),"export-broker-handle");
            Console.WriteLine("BROKER "+broker.pid+" "+brokerRemote.ToInt64()+" "+Birth(broker.process));Console.Out.Flush();
            string line;
            while((line=Console.ReadLine())!=null) {
                if(line.StartsWith("TARGET ")) {
                    if(target!=IntPtr.Zero)throw new Exception("target-already-adopted");
                    uint pid=uint.Parse(line.Substring(7));if(pid==broker.pid)throw new Exception("target-is-broker");
                    target=OpenProcess(0x101001,false,pid);Need(target!=IntPtr.Zero,"guard-open-target");
                    bool inside;Need(IsProcessInJob(target,job,out inside)&&inside,"target-not-in-guard");
                    IntPtr remote;Need(DuplicateHandle(GetCurrentProcess(),target,parent,out remote,0,false,2),"export-target-handle");
                    Accounting a=Count();Console.WriteLine("TARGET "+pid+" "+remote.ToInt64()+" "+Birth(target)+" "+a.active+" "+a.total);Console.WriteLine("MEMBERS "+Members());Console.Out.Flush();
                } else if(line=="KILL"||line=="KILL_WAIT_TARGET") {
                    bool awaitTarget=line=="KILL_WAIT_TARGET";
                    Need(target!=IntPtr.Zero,"target-not-captured");
                    Need(TerminateProcess(broker.process,193),"kill-broker-handle");Need(WaitForSingleObject(broker.process,5000)==0,"broker-wait");
                    if(awaitTarget)Need(WaitForSingleObject(target,5000)==0,"target-not-cleaned-by-broker-death");
                    System.Diagnostics.Stopwatch clock=System.Diagnostics.Stopwatch.StartNew();Accounting a;
                    do { a=Count();if(a.active<=(awaitTarget?0u:1u))break;Thread.Sleep(10); }while(clock.ElapsedMilliseconds<5000);
                    Console.WriteLine("AFTER "+a.active+" "+a.total);Console.WriteLine("AFTERMEMBERS "+Members());Console.Out.Flush();
                } else if(line=="CLEANUP") { Empty();Console.WriteLine("EMPTY 0");Console.Out.Flush();return 0; }
                else throw new Exception("guard-command");
            }
            Empty();return 0;
        } catch(Exception error) { Console.Error.WriteLine("GUARD_ERROR "+error.Message);return 125; }
        finally {
            if(deadline!=null)deadline.Dispose();
            try { Empty(); } catch(Exception e) { Console.Error.WriteLine("GUARD_CLEANUP "+e.Message); }
            // Also covers failed guardian assignment before START was released.
            if(broker.process!=IntPtr.Zero&&WaitForSingleObject(broker.process,0)==258) { TerminateProcess(broker.process,194);WaitForSingleObject(broker.process,5000); }
            lock(gate) { if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;} }
            foreach(IntPtr h in new IntPtr[]{target,broker.thread,broker.process,parent})if(h!=IntPtr.Zero)CloseHandle(h);
        }
    }
}
