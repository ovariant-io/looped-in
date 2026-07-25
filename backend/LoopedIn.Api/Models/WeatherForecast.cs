namespace LoopedIn.Api.Models;

/// <summary>Sample forecast model returned by <c>GET /weatherforecast</c>.</summary>
public sealed record WeatherForecast(DateOnly Date, int TemperatureC, string? Summary)
{
    public int TemperatureF => 32 + (int)(TemperatureC / 0.5556);
}
