// WidgetKit does not expose per-widget full-color host transparency. Keep this
// bridge confined to the extension; if its private descriptor contract changes,
// the two optional surfaces fall back to WidgetKit's normal opaque host.
#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <objc/runtime.h>

@interface TokenMonitorDescriptorResult : NSObject <NSSecureCoding>
@property (nonatomic, copy) NSArray *activityDescriptors;
@property (nonatomic, copy) NSArray *controlDescriptors;
@property (nonatomic, copy) NSArray *widgetDescriptors;
@end

@implementation TokenMonitorDescriptorResult

+ (BOOL)supportsSecureCoding { return YES; }

- (instancetype)initWithCoder:(NSCoder *)coder {
    self = [super init];
    if (!self) return nil;

    Class baseClass = objc_lookUpClass("CHSBaseDescriptor");
    Class controlClass = objc_lookUpClass("CHSControlDescriptor");
    Class widgetClass = objc_lookUpClass("CHSWidgetDescriptor");
    if (!baseClass || !controlClass || !widgetClass) return nil;

    _activityDescriptors = [coder decodeObjectOfClasses:[NSSet setWithObjects:NSArray.class, baseClass, nil]
                                                forKey:@"activityDescriptors"];
    _controlDescriptors = [coder decodeObjectOfClasses:[NSSet setWithObjects:NSArray.class, controlClass, nil]
                                               forKey:@"controlDescriptors"];
    NSArray *widgets = [coder decodeObjectOfClasses:[NSSet setWithObjects:NSArray.class, widgetClass, nil]
                                          forKey:@"widgetDescriptors"];
    if (!widgets) return nil;

    NSMutableArray *updated = [NSMutableArray arrayWithCapacity:widgets.count];
    for (id descriptor in widgets) {
        if (![descriptor respondsToSelector:@selector(kind)]) {
            [updated addObject:descriptor];
            continue;
        }
        NSString *kind = ((id (*)(id, SEL))objc_msgSend)(descriptor, @selector(kind));
        BOOL transparent = [kind isEqualToString:@"TokenMonitorTransparentWidget"];
        BOOL glass = [kind isEqualToString:@"TokenMonitorGlassWidget"];
        if (!transparent && !glass) {
            [updated addObject:descriptor];
            continue;
        }

        SEL removable = NSSelectorFromString(@"setBackgroundRemovable:");
        SEL seeThrough = NSSelectorFromString(@"setTransparent:");
        SEL backgroundStyle = NSSelectorFromString(@"setPreferredBackgroundStyle:");
        SEL vibrant = NSSelectorFromString(@"setSupportsVibrantContent:");
        SEL chrome = NSSelectorFromString(@"setSpatialChromeStyles:");
        if (![descriptor respondsToSelector:@selector(mutableCopyWithZone:)]) {
            [updated addObject:descriptor];
            continue;
        }
        id copy = [descriptor mutableCopy];
        if (![copy respondsToSelector:removable] || ![copy respondsToSelector:seeThrough]
            || ![copy respondsToSelector:backgroundStyle]
            || (glass && ![copy respondsToSelector:vibrant])) {
            [updated addObject:descriptor];
            continue;
        }
        ((void (*)(id, SEL, BOOL))objc_msgSend)(copy, removable, YES);
        // setTransparent: forces style 2, so the explicit style must come last.
        // Style 1 is a clear hole with no host material. Style 2 is the only
        // value that asks for a material background on every home-screen family,
        // including systemSmall. A SwiftUI material cannot sample the wallpaper.
        // Elevated chrome is the host highlight used by liquid glass surfaces.
        if (glass && [copy respondsToSelector:chrome]) {
            ((void (*)(id, SEL, NSUInteger))objc_msgSend)(copy, chrome, 1);
        }
        if (glass) ((void (*)(id, SEL, BOOL))objc_msgSend)(copy, vibrant, YES);
        ((void (*)(id, SEL, NSInteger))objc_msgSend)(copy, backgroundStyle, glass ? 2 : 1);
        [updated addObject:copy];
    }
    _widgetDescriptors = updated;
    return self;
}

- (void)encodeWithCoder:(NSCoder *)coder {
    [coder encodeObject:self.activityDescriptors forKey:@"activityDescriptors"];
    [coder encodeObject:self.controlDescriptors forKey:@"controlDescriptors"];
    [coder encodeObject:self.widgetDescriptors forKey:@"widgetDescriptors"];
}

@end

static void (*originalDescriptors)(id, SEL, id);

static void tokenMonitorDescriptors(id object, SEL command, void (^completion)(id)) {
    originalDescriptors(object, command, ^(id originalResult) {
        @try {
            if (!originalResult || ![originalResult respondsToSelector:@selector(encodeWithCoder:)]) {
                completion(originalResult);
                return;
            }
            NSKeyedArchiver *sourceArchive = [[NSKeyedArchiver alloc] initRequiringSecureCoding:YES];
            [originalResult encodeWithCoder:sourceArchive];
            NSError *error = nil;
            NSKeyedUnarchiver *source = [[NSKeyedUnarchiver alloc] initForReadingFromData:sourceArchive.encodedData error:&error];
            if (!source || error) { completion(originalResult); return; }
            TokenMonitorDescriptorResult *modified = [[TokenMonitorDescriptorResult alloc] initWithCoder:source];
            if (!modified) { completion(originalResult); return; }

            NSKeyedArchiver *outputArchive = [[NSKeyedArchiver alloc] initRequiringSecureCoding:YES];
            [modified encodeWithCoder:outputArchive];
            NSKeyedUnarchiver *output = [[NSKeyedUnarchiver alloc] initForReadingFromData:outputArchive.encodedData error:&error];
            Class resultClass = objc_lookUpClass("_TtC9WidgetKit21DescriptorFetchResult");
            if (!output || error || !resultClass || ![resultClass instancesRespondToSelector:@selector(initWithCoder:)]) {
                completion(originalResult);
                return;
            }
            id result = [(id<NSCoding>)[resultClass alloc] initWithCoder:output];
            completion(result ?: originalResult);
        } @catch (NSException *exception) {
            completion(originalResult);
        }
    });
}

@interface TokenMonitorWidgetHostSurface : NSObject
@end

@implementation TokenMonitorWidgetHostSurface

+ (void)load {
    Class exported = objc_lookUpClass("_TtCC9WidgetKit24WidgetExtensionXPCServer14ExportedObject");
    if (!exported || !objc_lookUpClass("_TtC9WidgetKit21DescriptorFetchResult")
        || !objc_lookUpClass("CHSWidgetDescriptor")) return;
    Method method = class_getInstanceMethod(exported, NSSelectorFromString(@"getAllCurrentDescriptorsWithCompletion:"));
    if (!method) return;
    originalDescriptors = (void (*)(id, SEL, id))method_getImplementation(method);
    method_setImplementation(method, (IMP)tokenMonitorDescriptors);
}

@end
