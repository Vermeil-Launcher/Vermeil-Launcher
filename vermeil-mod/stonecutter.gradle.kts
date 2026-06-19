plugins {
    id("dev.kikugie.stonecutter")
}
stonecutter active "26.2"

// Build every registered version node with a single command: `gradlew chiseledBuild`.
// Stonecutter 0.9 dropped the old `registerChiseled` helper; the supported way is
// task aggregation — `stonecutter.tasks.named(...)` returns a lazy collection of the
// matching task in every node, which we wire up as dependencies.
// https://stonecutter.kikugie.dev/wiki/config/controller#aggregation
tasks.register("chiseledBuild") {
    group = "build"
    description = "Builds all registered Stonecutter version nodes."
    dependsOn(stonecutter.tasks.named("build"))
}
