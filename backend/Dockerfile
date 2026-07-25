# syntax=docker/dockerfile:1

# ---- build: restore + publish ----
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Restore as a distinct layer for better caching.
# Copy the root build files first: global.json pins the SDK and the Directory.*.props
# drive Central Package Management (package versions live in Directory.Packages.props),
# so restore needs them or version-less PackageReferences fail with NU1015.
COPY global.json Directory.Build.props Directory.Packages.props ./
COPY LoopedIn.Api/LoopedIn.Api.csproj LoopedIn.Api/
RUN dotnet restore LoopedIn.Api/LoopedIn.Api.csproj

# Publish a framework-dependent build
COPY . .
RUN dotnet publish LoopedIn.Api/LoopedIn.Api.csproj -c Release -o /app /p:UseAppHost=false

# ---- runtime: ASP.NET Core runtime only ----
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
ENV ASPNETCORE_HTTP_PORTS=8080
COPY --from=build /app .
USER app
EXPOSE 8080
ENTRYPOINT ["dotnet", "LoopedIn.Api.dll"]
