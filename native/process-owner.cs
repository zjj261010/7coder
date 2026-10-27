// CLR 2.0 / Windows 7. No shell parsing, PID tree enumeration, or breakaway.
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

internal static class ProcessOwner {
    [StructLayout(LayoutKind.Sequential)] struct Startup {
        public int cb; public IntPtr reserved, desktop, title;
        public int x, y, width, height, charsX, charsY, fill, flags;
        public short show, reservedSize; public IntPtr reserved2, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long processTime, jobTime; public uint flags; public UIntPtr min, max;
        public uint active; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public BasicLimits basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long a,b,c,d; public uint faults, total, active, terminated;
    }
    [StructLayout(LayoutKind.Sequential)] struct Overlapped { public UIntPtr internalLow, internalHigh; public uint offset, offsetHigh; public IntPtr signal; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attr, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits info, int size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, int size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr from, IntPtr handle, IntPtr to, out IntPtr copy, uint access, bool inherit, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr attr, uint mode, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool WaitNamedPipeW(string name, uint timeout);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr file, IntPtr bytes, uint size, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr file, IntPtr bytes, uint size, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetOverlappedResult(IntPtr file, IntPtr overlapped, out uint transferred, bool wait);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateEventW(IntPtr attr, bool manual, bool initial, IntPtr name);
    static IntPtr pipe = new IntPtr(-1);
    static readonly ManualResetEvent go = new ManualResetEvent(false), stop = new ManualResetEvent(false), ack = new ManualResetEvent(false);
    static bool Transfer(byte[] bytes, bool write, out uint count) {
        // A synchronous duplex handle serializes ReadFile/WriteFile: the
        // watcher waiting for GO would prevent the main thread sending READY.
        Overlapped ov=new Overlapped(); ov.signal=CreateEventW(IntPtr.Zero,true,false,IntPtr.Zero);
        count=0; if(ov.signal==IntPtr.Zero) return false;
        // Both buffer and OVERLAPPED must remain at fixed native addresses
        // throughout IO_PENDING, including while another CLR thread allocates.
        IntPtr memory=Marshal.AllocHGlobal(bytes.Length), operation=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Overlapped)));
        try {
            Marshal.StructureToPtr(ov,operation,false); if(write) Marshal.Copy(bytes,0,memory,bytes.Length);
            bool ok=write ? WriteFile(pipe,memory,(uint)bytes.Length,out count,operation) : ReadFile(pipe,memory,(uint)bytes.Length,out count,operation);
            if(!ok && Marshal.GetLastWin32Error()!=997) return false;
            ok=GetOverlappedResult(pipe,operation,out count,true);
            if(ok && !write) Marshal.Copy(memory,bytes,0,(int)count);
            return ok;
        } finally { Marshal.FreeHGlobal(operation); Marshal.FreeHGlobal(memory); CloseHandle(ov.signal); }
    }
    static bool Send(string text) {
        byte[] data=Encoding.ASCII.GetBytes(text+"\n"); int offset=0;
        while(offset<data.Length) {
            uint count; byte[] tail=new byte[data.Length-offset]; Array.Copy(data,offset,tail,0,tail.Length);
            if(!Transfer(tail,true,out count)||count==0) return false;
            offset+=(int)count;
        }
        return true;
    }
    static string ReadLine() {
        byte[] b=new byte[1]; StringBuilder s=new StringBuilder();
        while(s.Length<128) { uint n; if(!Transfer(b,false,out n)||n!=1) return null;
            if(b[0]==10) return s.ToString(); if(b[0]>127) return null; s.Append((char)b[0]); }
        return null;
    }
    static void Watch() {
        for(;;) { string command=ReadLine();
            if(command=="GO") { go.Set(); continue; }
            if(command=="ACK") { ack.Set(); return; }
            stop.Set(); go.Set();
            if(command!="STOP") return; // EOF or invalid control fails closed.
        }
    }
    static void Require(bool ok, string stage) {
        if(!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),stage);
    }
    static IntPtr Standard(int id) {
        IntPtr copy;
        Require(DuplicateHandle(GetCurrentProcess(),GetStdHandle(id),GetCurrentProcess(),out copy,0,true,2),"duplicate-stdio");
        return copy;
    }
    static int Main(string[] args) {
        if(args.Length==1 && args[0]=="--probe") { Console.WriteLine("7coder-process-owner-v1 CLR="+Environment.Version.ToString()); return 0; }
        IntPtr job=IntPtr.Zero, input=IntPtr.Zero, output=IntPtr.Zero, error=IntPtr.Zero;
        ProcessInfo target=new ProcessInfo(); bool resumed=false;
        try {
            if(args.Length!=5 || args[0].Length>200 || args[1].Length!=48) throw new ArgumentException("invalid-protocol");
            string app=Encoding.Unicode.GetString(Convert.FromBase64String(args[2]));
            string command=Encoding.Unicode.GetString(Convert.FromBase64String(args[3]));
            if(app.Length==0 || command.Length>=32767 || app.IndexOf('\0')>=0 || command.IndexOf('\0')>=0) throw new ArgumentException("invalid-command");
            System.Diagnostics.Stopwatch connecting=System.Diagnostics.Stopwatch.StartNew();
            do { pipe=CreateFileW(args[0],0xc0000000,0,IntPtr.Zero,3,0x40000000,IntPtr.Zero);
                if(pipe!=new IntPtr(-1)) break; WaitNamedPipeW(args[0],100); Thread.Sleep(10);
            } while(connecting.ElapsedMilliseconds<20000);
            Require(pipe!=new IntPtr(-1),"connect-owner");
            if(!Send("HELLO "+args[1]+" "+GetCurrentProcessId()) || ReadLine()!="START") return 125;
            Thread watcher=new Thread(new ThreadStart(Watch)); watcher.IsBackground=true; watcher.Start();
            job=CreateJobObjectW(IntPtr.Zero,null); Require(job!=IntPtr.Zero,"create-job");
            Limits limits=new Limits(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE; no breakaway.
            Require(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(Limits))),"limit-job");
            input=Standard(-10); output=Standard(-11); error=Standard(-12);
            Startup startup=new Startup(); startup.cb=Marshal.SizeOf(typeof(Startup)); startup.flags=0x100;
            startup.stdin=input; startup.stdout=output; startup.stderr=error;
            if(stop.WaitOne(0,false)) return 125;
            Require(CreateProcessW(app,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,
                4u | (args[4]=="hidden" ? 0x08000000u : 0),IntPtr.Zero,null,ref startup,out target),"create-suspended");
            Require(AssignProcessToJobObject(job,target.process),"assign-job");
            if(!Send("READY "+target.pid)) stop.Set();
            if(!go.WaitOne(20000,false)) stop.Set();
            if(!stop.WaitOne(0,false)) { Require(ResumeThread(target.thread)!=0xffffffff,"resume-target"); resumed=true; }
            uint code=1;
            while(resumed && !stop.WaitOne(0,false)) {
                uint wait=WaitForSingleObject(target.process,100);
                if(wait==0) { Require(GetExitCodeProcess(target.process,out code),"exit-code"); break; }
                Require(wait==258,"wait-target");
            }
            // Natural root exit also retires surviving grandchildren. Keep the
            // sole job handle until accounting confirms every member has exited.
            Require(TerminateJobObject(job,1),"terminate-job");
            System.Diagnostics.Stopwatch closing=System.Diagnostics.Stopwatch.StartNew();
            for(;;) {
                Accounting state; Require(QueryInformationJobObject(job,1,out state,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),"query-job");
                if(state.active==0) break;
                if(closing.ElapsedMilliseconds>=5000) throw new InvalidOperationException("cleanup-deadline");
                Thread.Sleep(10);
            }
            if(Send((stop.WaitOne(0,false)?"STOPPED ":"EXIT ")+code)) ack.WaitOne(2000,false);
            return unchecked((int)code);
        } catch(Exception ex) {
            System.ComponentModel.Win32Exception win=ex as System.ComponentModel.Win32Exception;
            string detail=win!=null ? win.Message+" (Win32 "+win.NativeErrorCode+")" : ex.Message;
            Send("ERROR "+(win!=null ? win.NativeErrorCode.ToString() : "0"));
            Console.Error.WriteLine("[PROCESS] containment failed: "+detail+"; target "+(resumed?"cleanup unconfirmed":"not resumed")+".");
            return 125;
        } finally {
            // Assignment failure must not leave a suspended, unowned process.
            if(target.process!=IntPtr.Zero && !resumed) { TerminateProcess(target.process,125); WaitForSingleObject(target.process,5000); }
            if(job!=IntPtr.Zero) CloseHandle(job);
            foreach(IntPtr h in new IntPtr[]{target.thread,target.process,input,output,error}) if(h!=IntPtr.Zero) CloseHandle(h);
            // A background ReadFile may be pending. Process teardown closes the
            // pipe; do not recycle its numeric handle underneath that read.
        }
    }
}
