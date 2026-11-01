"""Instantaneous world-wide energy grid. Surplus is never stored."""
from .state import ENERGY_CONSUMPTION, SOLAR_ENERGY_OUTPUT, WIND_ENERGY_OUTPUT


def energy_balance(state):
    completed = [b for b in state.buildings.values() if b.construction_status == "completed"]
    output = {"solar_panel": SOLAR_ENERGY_OUTPUT, "wind_turbine": WIND_ENERGY_OUTPUT}
    production = sum(output.get(b.building_type, 0) for b in completed)
    consumption = sum(ENERGY_CONSUMPTION.get(b.building_type, 0) for b in completed)
    efficiency = min(1.0, production / consumption) if consumption else 1.0
    return {"production": production, "consumption": consumption, "efficiency": efficiency}
