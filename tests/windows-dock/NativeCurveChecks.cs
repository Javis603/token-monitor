using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Windows.UI.Composition;

class CheckPoint { public float x { get; set; } public float y { get; set; } public bool inside { get; set; } }
class CheckCase { public string name { get; set; } public object[][] commands { get; set; } public List<CheckPoint> points { get; set; } }
class NativeCurveChecks {
    [StructLayout(LayoutKind.Sequential)] struct QueueOptions { public int size, thread, apartment; }
    [DllImport("CoreMessaging.dll")] static extern int CreateDispatcherQueueController(QueueOptions options, out IntPtr controller);
    [STAThread] static int Main(string[] args) {
        IntPtr queue = IntPtr.Zero;
        try {
            Marshal.ThrowExceptionForHR(CreateDispatcherQueueController(new QueueOptions { size = 12, thread = 2, apartment = 2 }, out queue));
            using (var compositor = new Compositor()) {
                var cases = new JavaScriptSerializer().Deserialize<List<CheckCase>>(File.ReadAllText(args[0]));
                int count = 0;
                foreach (var check in cases) using (var curve = new NativeCurveGeometry(check.commands)) {
                    using (var path = compositor.CreatePathGeometry(new CompositionPath(curve)))
                    using (var clip = compositor.CreateGeometricClip(path)) {
                        foreach (var point in check.points) {
                            if (curve.Contains(point.x, point.y) != point.inside)
                                throw new Exception(check.name + " differs from renderer mask at " + point.x + "," + point.y);
                            count++;
                        }
                    }
                }
                Console.WriteLine(cases.Count + " native shapes / " + count + " mask points");
            }
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally { if (queue != IntPtr.Zero) Marshal.Release(queue); }
    }
}
