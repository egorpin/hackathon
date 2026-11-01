"""Instantaneous world-wide energy grid. Surplus is never stored."""
from .state import ENERGY_CONSUMPTION, SOLAR_ENERGY_OUTPUT


def energy_balance(state):
    production = sum(b.building_type == "solar_panel" for b in state.buildings.values()) * SOLAR_ENERGY_OUTPUT
    consumption = sum(ENERGY_CONSUMPTION.get(b.building_type, 0) for b in state.buildings.values())
    efficiency = min(1.0, production / consumption) if consumption else 1.0
    return {"production": production, "consumption": consumption, "efficiency": efficiency}
