using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Windows.Graphics;

// Public geometry interop contract from windows.graphics.interop.h.
[ComVisible(true),Guid("0657AF73-53FD-47CF-84FF-C8492D2A80A3"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ICurveGeometryInterop {
  [PreserveSig] int GetGeometry(out IntPtr geometry);
  [PreserveSig] int TryGetGeometryUsingFactory(IntPtr factory,out IntPtr geometry);
}

[ComVisible(true),ClassInterface(ClassInterfaceType.None)]
public sealed class NativeCurveGeometry : IGeometrySource2D, ICurveGeometryInterop, IDisposable {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public float X,Y;public Point(float x,float y){X=x;Y=y;} }
  [StructLayout(LayoutKind.Sequential)] public struct Bezier { public Point A,B,C; }
  [StructLayout(LayoutKind.Sequential)] public struct Bounds { public float Left,Top,Right,Bottom; }
  [DllImport("d2d1.dll")] static extern int D2D1CreateFactory(uint type,ref Guid iid,IntPtr options,out IntPtr factory);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreatePath(IntPtr self,out IntPtr result);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OpenPath(IntPtr self,out IntPtr result);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void EnumCall(IntPtr self,uint value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void Begin(IntPtr self,Point point,uint value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void Line(IntPtr self,Point point);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void Curve(IntPtr self,ref Bezier curve);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ClosePath(IntPtr self);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetBoundsNative(IntPtr self,IntPtr transform,out Bounds bounds);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ContainsNative(IntPtr self,Point point,IntPtr transform,float tolerance,out int contains);
  IntPtr factory,geometry;
  static T Method<T>(IntPtr instance,int slot){return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(instance),slot*IntPtr.Size),typeof(T));}
  public NativeCurveGeometry(IEnumerable<object[]> commands) {
    var iid=new Guid("06152247-6F50-465A-9245-118BFD3B6007");
    Marshal.ThrowExceptionForHR(D2D1CreateFactory(0,ref iid,IntPtr.Zero,out factory));
    try {
      Marshal.ThrowExceptionForHR(Method<CreatePath>(factory,10)(factory,out geometry));
      IntPtr sink;Marshal.ThrowExceptionForHR(Method<OpenPath>(geometry,17)(geometry,out sink));
      try {
        Method<EnumCall>(sink,3)(sink,1);
        bool open=false;
        foreach(var command in commands) {
          string op=(string)command[0];
          if(op=="M") {if(open)Method<EnumCall>(sink,8)(sink,1);Method<Begin>(sink,5)(sink,new Point(Convert.ToSingle(command[1]),Convert.ToSingle(command[2])),0);open=true;}
          else if(op=="L")Method<Line>(sink,10)(sink,new Point(Convert.ToSingle(command[1]),Convert.ToSingle(command[2])));
          else if(op=="C"){var curve=new Bezier{A=new Point(Convert.ToSingle(command[1]),Convert.ToSingle(command[2])),B=new Point(Convert.ToSingle(command[3]),Convert.ToSingle(command[4])),C=new Point(Convert.ToSingle(command[5]),Convert.ToSingle(command[6]))};Method<Curve>(sink,11)(sink,ref curve);}
          else if(op=="Z"){Method<EnumCall>(sink,8)(sink,1);open=false;}
          else throw new ArgumentException("Unsupported curve command: "+op);
        }
        if(open)Method<EnumCall>(sink,8)(sink,1);
        Marshal.ThrowExceptionForHR(Method<ClosePath>(sink,9)(sink));
      }finally{Marshal.Release(sink);}
    }catch{Dispose();throw;}
  }
  public Bounds GetBounds(){Bounds result;Marshal.ThrowExceptionForHR(Method<GetBoundsNative>(geometry,4)(geometry,IntPtr.Zero,out result));return result;}
  public bool Contains(float x,float y){int result;Marshal.ThrowExceptionForHR(Method<ContainsNative>(geometry,7)(geometry,new Point(x,y),IntPtr.Zero,0.25f,out result));return result!=0;}
  public int GetGeometry(out IntPtr value){value=geometry;if(value==IntPtr.Zero)return unchecked((int)0x80004005);Marshal.AddRef(value);return 0;}
  public int TryGetGeometryUsingFactory(IntPtr source,out IntPtr value){value=IntPtr.Zero;return unchecked((int)0x80004001);}
  public void Dispose(){if(geometry!=IntPtr.Zero){Marshal.Release(geometry);geometry=IntPtr.Zero;}if(factory!=IntPtr.Zero){Marshal.Release(factory);factory=IntPtr.Zero;}GC.SuppressFinalize(this);}
  ~NativeCurveGeometry(){Dispose();}
}
